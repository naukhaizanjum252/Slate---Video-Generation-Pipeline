import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import AdmZip from 'adm-zip';
import * as tmp from 'tmp';
import type { PipelineResult, ProgressStep, PhaseStatus, TimelinePhase } from '@slate/shared';
import { createLogger } from './logger';
import { TrelloClient, type TrelloCard, type TrelloAttachment } from './trello';
import { DriveUploader } from './drive';
import { EpisodeStore } from './supabase';
import type { Config } from './config';
import { probeVideo } from './video';
import { buildIntroSpec } from './intro';
import { specFromPreset } from './introPreset';
import { autoCaptionSrt } from './captions';
import { buildEditedVideo } from './editedVideo';

const log = createLogger('pipeline');

/** Outcome of running pipeline.py — failures carry a kind + diagnostic details. */
type PyRunResult =
  | { success: true; zip_path: string; episode_name: string }
  | { success: false; kind: 'cancel' | 'stall' | 'error'; error: string; details?: string };

// How often to poll Supabase for a stop request while a pipeline runs.
const CANCEL_POLL_MS = 10000;
// How often the stall watchdog checks for lack of progress.
const STALL_CHECK_MS = 30000;
// Min gap between stage writes to Supabase (coalesces rapid progress updates).
const STAGE_WRITE_MS = 3000;

export interface PipelineDeps {
  cfg: Config;
  trello: TrelloClient;
  drive: DriveUploader;
  store: EpisodeStore;
}

/** The slice of a channel's config a running job needs. */
export interface JobChannel {
  id: string;
  name: string;
  driveFolderId: string;
  /** Trello list to move the card to when done (empty = don't move). */
  resolveListId: string;
  /** When true: build the final video (effect + boom + intro), upload only it. */
  videoMode: boolean;
  /** When true: also build the edited intro (via the compositor) and upload it to Drive. */
  editIntroOnly: boolean;
  /** Saved intro-editor preset id driving the edited intro's look (or null). */
  introPresetId: string | null;
}

export interface PipelineJob {
  cardId: string;
  cardTitle: string;
  brief: string;
  episodeName: string;
  attachment: TrelloAttachment;
  channel: JobChannel;
  /** Intro clip to prepend in video mode (first video attachment), if any. */
  introAttachment?: TrelloAttachment | null;
  /** Intro voiceover (first audio attachment), for the edited-intro build. */
  voiceoverAttachment?: TrelloAttachment | null;
  /** Caption SRT/VTT attachment for the intro (wins over auto-caption), if any. */
  captionsAttachment?: TrelloAttachment | null;
  /** Subject name (INTRO_SUBJECT_NAME) shown on the edited intro's name plate. */
  subjectName?: string | null;
  /** Seconds into the episode for the freeze+flash+boom effect, if specified. */
  effectTimestampSec?: number | null;
}

/**
 * Run the full pipeline for one card end-to-end. This is intentionally
 * self-contained and never throws: every failure is caught, recorded in
 * Supabase, and reflected on the Trello board. Temp files are always
 * cleaned up via finally blocks.
 */
export async function runPipeline(job: PipelineJob, deps: PipelineDeps): Promise<void> {
  const { cfg, trello, drive, store } = deps;
  log.info(`Starting pipeline for "${job.cardTitle}" (${job.episodeName})`);

  // Temp resources to clean up no matter what. (Video-mode temps are managed
  // locally inside finalizeVideo's own try/finally.)
  let imageTmp: tmp.FileResult | null = null;
  let unzipDir: tmp.DirResult | null = null;

  // ── Video mode ─────────────────────────────────────────────────────
  // Per-channel: after the studio generates the package, build OUR edit (intro + body)
  // and upload ONLY that final video. The studio no longer builds video.
  const videoMode = job.channel.videoMode;
  const introOnly = videoMode && job.channel.editIntroOnly;

  // ── Pipeline timeline ──────────────────────────────────────────────
  // Ordered phases for this run. Persisted to Supabase and kept after the run so
  // the dashboard can show a full stepper. Intro-only skips studio generation, so
  // it has its own short timeline rather than the full-generation phases.
  const phaseDefs: { key: string; label: string }[] = introOnly
    ? [
        { key: 'Downloading intro', label: 'Download intro' },
        { key: 'Editing intro', label: 'Edit intro' },
        { key: 'Uploading to Drive', label: 'Upload to Drive' },
      ]
    : [
        { key: 'Downloading reference', label: 'Reference image' },
        { key: 'Enhancing reference', label: 'Enhance reference' },
        { key: 'Generating script & assets', label: 'Script & assets' },
        { key: 'Packaging files', label: 'Package files' },
        { key: 'Unpacking bundle', label: 'Unpack bundle' },
        // Video mode builds our edit; package mode just uploads the bundle.
        ...(videoMode
          ? [
              { key: 'Editing intro', label: 'Edit intro' },
              { key: 'Rendering body', label: 'Render body' },
              { key: 'Stitching intro', label: 'Stitch intro' },
            ]
          : []),
        { key: 'Uploading to Drive', label: 'Upload to Drive' },
      ];
  let currentKey = '';
  const stepsByPhase: Record<string, ProgressStep[]> = {};

  const buildPhase = (key: string, label: string, status: PhaseStatus): TimelinePhase => {
    const steps = stepsByPhase[key];
    return steps ? { key, label, status, steps } : { key, label, status };
  };
  // Timeline where the current phase carries `curStatus` (active/failed),
  // earlier phases are done, later ones pending.
  const timelineWith = (curStatus: PhaseStatus): TimelinePhase[] => {
    const curIdx = phaseDefs.findIndex((p) => p.key === currentKey);
    return phaseDefs.map((p, i) =>
      buildPhase(p.key, p.label, i < curIdx ? 'done' : i === curIdx ? curStatus : 'pending'),
    );
  };
  const timelineAllDone = (): TimelinePhase[] =>
    phaseDefs.map((p) => buildPhase(p.key, p.label, 'done'));

  // Throttled live-status writer. Coalesces rapid progress updates into at most
  // one Supabase write per STAGE_WRITE_MS, dedupes identical payloads, and is
  // fully disabled once the run ends so a trailing write can't clobber the final
  // done/failed state. Carries a high-level phase + its concurrent sub-steps.
  let lastKey = '';
  let lastWriteAt = 0;
  let pending: { phase: string; steps: ProgressStep[] } | null = null;
  let stageTimer: ReturnType<typeof setTimeout> | null = null;
  let stageClosed = false;

  const keyOf = (phase: string, steps: ProgressStep[]) => `${phase}|${JSON.stringify(steps)}`;

  const flushStage = () => {
    if (stageTimer) {
      clearTimeout(stageTimer);
      stageTimer = null;
    }
    if (stageClosed || pending === null) return;
    const p = pending;
    pending = null;
    lastWriteAt = Date.now();
    const key = keyOf(p.phase, p.steps);
    if (key === lastKey) return;
    lastKey = key;
    void store
      .updateStage(job.cardId, p.phase, p.steps, timelineWith('active'))
      .catch((e) => log.warn('updateStage failed', e));
  };

  const setStage = (phase: string, steps: ProgressStep[] = []) => {
    if (stageClosed || keyOf(phase, steps) === lastKey) return;
    currentKey = phase;
    if (steps.length) stepsByPhase[phase] = steps;
    pending = { phase, steps };
    const elapsed = Date.now() - lastWriteAt;
    if (elapsed >= STAGE_WRITE_MS) {
      flushStage();
    } else if (!stageTimer) {
      stageTimer = setTimeout(flushStage, STAGE_WRITE_MS - elapsed);
    }
  };

  // Unzip a bundle zip to a temp dir; caller assigns `unzipDir` for cleanup.
  const unzipBundle = (zipPath: string): { dir: tmp.DirResult; root: string } => {
    if (!fs.existsSync(zipPath)) throw new Error(`Zip path does not exist on disk: ${zipPath}`);
    const dir = tmp.dirSync({ prefix: 'slate-bundle-', unsafeCleanup: true });
    new AdmZip(zipPath).extractAllTo(dir.name, /* overwrite */ true);
    log.info(`Unzipped bundle -> ${dir.name}`);
    return { dir, root: collapseSingleRoot(dir.name) };
  };

  // Mark done in Supabase, then move the card to the resolve list + comment
  // (best-effort). Shared by both upload paths.
  const finalizeDone = async (driveUrl: string): Promise<void> => {
    await store.markDone(job.cardId, driveUrl, timelineAllDone());
    log.info(`✅ Completed "${job.cardTitle}" -> ${driveUrl}`);
    if (job.channel.resolveListId) {
      try {
        await trello.moveCard(job.cardId, job.channel.resolveListId);
        await trello.addComment(job.cardId, `✅ Episode ready — Drive folder: ${driveUrl}`);
      } catch (e) {
        log.warn('Failed to move card to resolve list / add comment', e);
      }
    } else {
      log.warn(`[${job.channel.name}] No resolve list configured — card left in source list`);
    }
  };

  // Asset-bundle path: upload the whole unzipped bundle.
  const uploadAndFinalize = async (rootDir: string): Promise<void> => {
    setStage('Uploading to Drive');
    const driveUrl = await drive.uploadEpisodeFolder(
      job.cardTitle,
      rootDir,
      job.channel.driveFolderId,
    );
    await finalizeDone(driveUrl);
  };

  // Video-mode path: build OUR edit (intro + body) from the generated package, then
  // upload ONLY the final video (in a folder named after the card). This replaces the
  // studio's /cb_build_video entirely. Manages its own temp cleanup in a local finally.
  const finalizeVideo = async (rootDir: string): Promise<void> => {
    const work = tmp.dirSync({ prefix: 'slate-video-', unsafeCleanup: true });
    let introFile: tmp.FileResult | null = null;
    try {
      // Intro raw clip from the card's video attachment (if any).
      let introClipPath: string | null = null;
      if (job.introAttachment) {
        introFile = tmp.fileSync({ prefix: 'slate-intro-', postfix: guessVideoExt(job.introAttachment) });
        await trello.downloadAttachment(job.introAttachment, introFile.name);
        introClipPath = introFile.name;
      }
      const presetParams = job.channel.introPresetId
        ? (await store.getIntroPreset(job.channel.introPresetId))?.params ?? null
        : null;

      const uploadDir = path.join(work.name, 'upload');
      fs.mkdirSync(uploadDir, { recursive: true });
      const out = path.join(uploadDir, `${sanitizeFilename(job.cardTitle)}.mp4`);
      await buildEditedVideo({
        bundleRoot: rootDir,
        introClipPath,
        presetParams,
        outPath: out,
        workDir: path.join(work.name, 'edit'),
        onProgress: (s) =>
          s.startsWith('Rendering body') || s === 'Assembling body'
            ? setStage('Rendering body', [{ label: 'Body', text: s }])
            : setStage(s), // 'Editing intro' | 'Stitching intro'
        isCancelled: () => store.isCancelRequested(job.cardId),
      });

      setStage('Uploading to Drive');
      const driveUrl = await drive.uploadEpisodeFolder(job.cardTitle, uploadDir, job.channel.driveFolderId);
      await finalizeDone(driveUrl);
    } finally {
      try {
        introFile?.removeCallback();
      } catch {
        /* ignore */
      }
      try {
        work.removeCallback();
      } catch {
        /* ignore */
      }
    }
  };

  // Build the edited intro (compositor + the channel's preset) from the card's
  // video attachment and upload it to the channel's Drive folder. Best-effort: a
  // failure here is logged but never fails the (already-completed) episode.
  const buildEditedIntro = async (): Promise<string> => {
    const intro = job.introAttachment;
    if (!intro) {
      throw new Error('No video attachment on the card to build the intro from.');
    }
    const work = tmp.dirSync({ prefix: 'slate-introbuild-', unsafeCleanup: true });
    try {
      setStage('Downloading intro');
      const introPath = path.join(work.name, `intro${guessVideoExt(intro)}`);
      await trello.downloadAttachment(intro, introPath);
      let voPath: string | null = null;
      if (job.voiceoverAttachment) {
        const ext = path.extname((job.voiceoverAttachment.url || '').split('?')[0]) || '.mp3';
        voPath = path.join(work.name, `vo${ext}`);
        await trello.downloadAttachment(job.voiceoverAttachment, voPath);
      }
      const introInfo = await probeVideo(introPath);
      const voInfo = voPath ? await probeVideo(voPath) : null;
      const params = job.channel.introPresetId
        ? (await store.getIntroPreset(job.channel.introPresetId))?.params ?? null
        : null;
      const spec = specFromPreset(params, {
        clipDuration: introInfo.duration,
        voDuration: voInfo?.duration ?? 0,
        subjectName: job.subjectName ?? '',
        pauseAtSec: job.effectTimestampSec ?? 0,
      });
      setStage('Editing intro');
      // Captions: a card SRT/VTT attachment wins; otherwise auto-caption the
      // voiceover (Whisper). Both skip gracefully (no SRT + no key → no captions).
      let captionsSrt: string | null = null;
      if (job.captionsAttachment) {
        captionsSrt = path.join(work.name, 'captions.srt');
        await trello.downloadAttachment(job.captionsAttachment, captionsSrt);
      } else if (voPath) {
        captionsSrt = await autoCaptionSrt(voPath, work.name);
      }
      log.info(
        `[${job.channel.name}] intro build — name="${spec.subjectName}" ` +
          `nameplate=${spec.hasText !== false && !!spec.subjectName ? 'on' : 'off'} ` +
          `preset=${job.channel.introPresetId ?? 'default'} captions=${captionsSrt ? 'yes' : 'none'} ` +
          `clip=${introInfo.duration.toFixed(1)}s vo=${(voInfo?.duration ?? 0).toFixed(1)}s`,
      );
      const outPath = path.join(work.name, `${job.episodeName}-intro.mp4`);
      await buildIntroSpec(introPath, voPath, spec, outPath, captionsSrt);
      setStage('Uploading to Drive');
      // Upload into a per-episode subfolder (named like the card) — not loose in
      // the channel's parent folder.
      const url = await drive.uploadFileToNewFolder(outPath, job.cardTitle, job.channel.driveFolderId);
      log.info(`[${job.channel.name}] edited intro uploaded -> ${url}`);
      return url;
    } finally {
      try {
        work.removeCallback();
      } catch {
        /* ignore */
      }
    }
  };

  // Dispatch to the right finalize path based on the channel's mode.
  const finalize = (rootDir: string): Promise<void> =>
    videoMode ? finalizeVideo(rootDir) : uploadAndFinalize(rootDir);

  const handlePyFailure = async (
    result: { kind: 'cancel' | 'stall' | 'error'; error: string; details?: string },
    stageWhenCancelled = 'active' as PhaseStatus,
  ): Promise<void> => {
    if (result.kind === 'cancel') {
      await store.markCancelled(job.cardId, timelineWith(stageWhenCancelled));
      log.info(`🛑 Cancelled "${job.cardTitle}" (${job.episodeName})`);
      return;
    }
    const headline =
      result.kind === 'stall'
        ? `Pipeline stalled — no progress for ${cfg.stallTimeoutMin}m` +
          (result.error ? ` (last: ${result.error})` : '')
        : `Pipeline failed: ${result.error}`;
    const studioLog = await captureStudioLog(cfg.studioLogUnit).catch(() => '');
    const parts = [headline];
    if (result.details) parts.push(`── pipeline output ──\n${result.details}`);
    if (studioLog) parts.push(`── studio log (${cfg.studioLogUnit}) ──\n${studioLog}`);
    throw new Error(parts.join('\n\n'));
  };

  try {
    // Intro-only: skip studio generation entirely — just edit the card's intro
    // clip with the channel's preset and upload it to Drive.
    if (introOnly) {
      const introUrl = await buildEditedIntro();
      await finalizeDone(introUrl);
      return;
    }

    // 0. Reuse: probe for an already-complete bundle and skip generation if found.
    if (cfg.reuseExisting) {
      setStage('Checking for existing output');
      const probe = await runPythonPipeline(
        {
          episodeName: job.episodeName,
          brief: job.brief,
          imagePath: 'none',
          gradioUrl: cfg.gradio.baseUrl,
          timeoutMin: cfg.probeTimeoutMin,
          downloadOnly: true,
        },
        cfg.pythonBin,
        cfg.probeTimeoutMin * 60_000,
        cfg.probeTimeoutMin * 60_000,
        setStage,
        () => store.isCancelRequested(job.cardId),
      );
      if (probe.success && fs.existsSync(probe.zip_path)) {
        const { dir, root } = unzipBundle(probe.zip_path);
        unzipDir = dir;
        // The studio only produces the package; "complete" means the package is present.
        // Video mode then builds our edit from it in finalize.
        if (isCompleteBundle(root)) {
          log.info(`♻️  Reusing existing output for "${job.cardTitle}" — skipping generation`);
          await finalize(root);
          return;
        }
        log.info(`Existing output incomplete — regenerating "${job.cardTitle}"`);
        try {
          dir.removeCallback();
        } catch {
          /* ignore */
        }
        unzipDir = null;
      } else if (!probe.success && probe.kind === 'cancel') {
        await store.markCancelled(job.cardId, timelineWith('active'));
        log.info(`🛑 Cancelled "${job.cardTitle}" during reuse probe`);
        return;
      }
      // Otherwise no reusable bundle (expected for fresh episodes) — generate.
    }

    // 1. Download the Trello reference image to a temp file.
    setStage('Downloading reference');
    const ext = guessImageExt(job.attachment);
    imageTmp = tmp.fileSync({ prefix: 'slate-ref-', postfix: ext });
    await trello.downloadAttachment(job.attachment, imageTmp.name);

    // 2. Spawn pipeline.py for the full generation run.
    const result = await runPythonPipeline(
      {
        episodeName: job.episodeName,
        brief: job.brief,
        imagePath: imageTmp.name,
        gradioUrl: cfg.gradio.baseUrl,
        timeoutMin: cfg.pipelineTimeoutMin,
        downloadOnly: false,
      },
      cfg.pythonBin,
      cfg.pipelineTimeoutMin * 60_000,
      cfg.stallTimeoutMin * 60_000,
      setStage,
      () => store.isCancelRequested(job.cardId),
    );

    if (!result.success) {
      await handlePyFailure(result);
      return;
    }

    // Honor a stop requested after generation finished but before upload.
    if (await store.isCancelRequested(job.cardId)) {
      await store.markCancelled(job.cardId, timelineWith('active'));
      log.info(`🛑 Cancelled "${job.cardTitle}" before upload`);
      return;
    }

    // 3. Unzip the bundle, then 4. finalize (assets bundle, or video post-processing).
    setStage('Unpacking bundle');
    const { dir, root } = unzipBundle(result.zip_path);
    unzipDir = dir;
    await finalize(root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A cancellation (Stop pressed mid-render → aborted ffmpeg) is not a failure.
    const cancelled = /cancel/i.test(message) || (await store.isCancelRequested(job.cardId).catch(() => false));
    try {
      if (cancelled) {
        log.info(`🛑 Cancelled "${job.cardTitle}" during render`);
        await store.markCancelled(job.cardId, timelineWith('active'));
      } else {
        log.error(`❌ Pipeline error for "${job.cardTitle}": ${message}`, err);
        await store.markFailed(job.cardId, message, timelineWith('failed'));
      }
    } catch (e) {
      log.error('Failed to record final state in Supabase', e);
    }
  } finally {
    // Stop the stage throttle so no trailing write overwrites the final state.
    stageClosed = true;
    if (stageTimer) clearTimeout(stageTimer);

    // 6. Always clean up temp files.
    try {
      imageTmp?.removeCallback();
    } catch {
      /* ignore */
    }
    try {
      unzipDir?.removeCallback();
    } catch {
      /* ignore */
    }
  }
}

interface PyArgs {
  episodeName: string;
  brief: string;
  imagePath: string;
  gradioUrl: string;
  timeoutMin: number;
  downloadOnly: boolean;
}

/**
 * Spawn pipeline.py and resolve with the parsed PipelineResult. Rejects only
 * on spawn-level failures or unparseable output; pipeline logic failures come
 * back as { success: false } which the caller handles.
 *
 * Primary guard: a STALL watchdog that fails fast if progress doesn't CHANGE for
 * `stallTimeoutMs` — so a slow-but-advancing run is allowed to finish while a
 * truly wedged step (including one stuck re-emitting the same status) is killed.
 * A HARD timeout (`pipelineTimeoutMs`) is an OPTIONAL absolute ceiling, disabled
 * when <= 0 (the default for full runs) and still used to bound the reuse probe.
 */
function runPythonPipeline(
  args: PyArgs,
  pythonBin: string,
  pipelineTimeoutMs: number,
  stallTimeoutMs: number,
  onProgress?: (phase: string, steps: ProgressStep[]) => void,
  isCancelRequested?: () => Promise<boolean>,
): Promise<PyRunResult> {
  const scriptPath = resolvePipelineScript();

  const argv = [
    scriptPath,
    '--episode-name',
    args.episodeName,
    '--brief',
    args.brief,
    '--image-path',
    args.imagePath,
    '--gradio-url',
    args.gradioUrl,
    '--timeout-min',
    String(args.timeoutMin),
  ];
  if (args.downloadOnly) argv.push('--download-only');

  return new Promise<PyRunResult>((resolve) => {
    const child = spawn(pythonBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setInterval> | undefined;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    // Liveness for stall detection: bumped only when progress actually CHANGES
    // (see the stderr handler), so a run that keeps re-emitting the same status
    // without advancing still trips the stall watchdog.
    let lastProgressAt = Date.now();
    let lastProgressLabel = '';
    let lastProgressPayload = '';

    const tail = () => stderr.trim().split('\n').slice(-40).join('\n').slice(-1800);

    const cleanup = () => {
      if (hardTimer) clearTimeout(hardTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (stallTimer) clearInterval(stallTimer);
    };

    // Optional absolute ceiling. Disabled when pipelineTimeoutMs <= 0 — the main
    // run then relies solely on the stall watchdog, so a slow-but-progressing
    // episode is allowed to finish. Still used to bound the quick reuse probe,
    // which passes a positive value. When armed, it kills even a healthy run.
    if (pipelineTimeoutMs > 0) {
      hardTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill('SIGKILL');
        resolve({
          success: false,
          kind: 'error',
          error: `Hard timeout after ${Math.round(pipelineTimeoutMs / 60000)}m`,
          details: tail(),
        });
      }, pipelineTimeoutMs);
    }

    // Stall watchdog: if no PROGRESS arrives for stallTimeoutMs, the studio/69labs
    // step is wedged — kill and report a stall (distinct from the hard timeout).
    stallTimer = setInterval(() => {
      if (settled) return;
      if (Date.now() - lastProgressAt > stallTimeoutMs) {
        settled = true;
        cleanup();
        child.kill('SIGKILL');
        resolve({ success: false, kind: 'stall', error: lastProgressLabel, details: tail() });
      }
    }, STALL_CHECK_MS);

    // Poll for a dashboard stop request; if seen, kill the child and resolve cancelled.
    if (isCancelRequested) {
      cancelTimer = setInterval(() => {
        if (settled) return;
        isCancelRequested()
          .then((wantStop) => {
            if (!wantStop || settled) return;
            settled = true;
            cleanup();
            child.kill('SIGKILL');
            resolve({ success: false, kind: 'cancel', error: '' });
          })
          .catch(() => {
            /* ignore transient poll errors */
          });
      }, CANCEL_POLL_MS);
    }

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      // Surface python lines into our logs, and relay any "PROGRESS <json>"
      // markers (phase + concurrent steps) to the live-status callback.
      for (const line of d.toString().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        log.info(`[py] ${trimmed}`);
        const m = trimmed.match(/PROGRESS (\{.*\})\s*$/);
        if (m) {
          // Only a CHANGED payload counts as real forward movement. Resetting on
          // every line (even an identical one) would let a wedged-but-chatty
          // studio keep the stall watchdog alive forever — which matters now
          // that the hard cap can be disabled.
          if (m[1] !== lastProgressPayload) {
            lastProgressPayload = m[1];
            lastProgressAt = Date.now();
          }
          try {
            const parsed = JSON.parse(m[1]) as { phase?: string; steps?: ProgressStep[] };
            if (parsed && typeof parsed.phase === 'string') {
              const active = (parsed.steps ?? []).map((s) => s.label).join(', ');
              lastProgressLabel = active ? `${parsed.phase} (${active})` : parsed.phase;
              if (onProgress) onProgress(parsed.phase, Array.isArray(parsed.steps) ? parsed.steps : []);
            }
          } catch {
            /* ignore malformed progress lines */
          }
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ success: false, kind: 'error', error: `Failed to spawn ${pythonBin}: ${err.message}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({
          success: false,
          kind: 'error',
          error: `pipeline.py exited (code ${code}) with no result`,
          details: tail(),
        });
        return;
      }
      // The contract is a single JSON line; take the last JSON-looking line.
      const jsonLine = lastJsonLine(trimmed);
      if (!jsonLine) {
        resolve({ success: false, kind: 'error', error: 'No JSON result from pipeline.py', details: tail() });
        return;
      }
      try {
        const parsed = JSON.parse(jsonLine) as PipelineResult;
        if (parsed.success) {
          resolve({ success: true, zip_path: parsed.zip_path, episode_name: parsed.episode_name });
        } else {
          resolve({ success: false, kind: 'error', error: parsed.error, details: tail() });
        }
      } catch {
        resolve({ success: false, kind: 'error', error: `Invalid JSON: ${jsonLine}`, details: tail() });
      }
    });
  });
}

/**
 * Best-effort capture of the studio's recent journal (the real cause of a stall
 * usually lives there, not in pipeline.py's output). Returns '' if unavailable.
 */
function captureStudioLog(unit: string): Promise<string> {
  if (!unit) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile(
      'journalctl',
      ['-u', unit, '--no-pager', '-n', '200'],
      { timeout: 8000, maxBuffer: 4_000_000 },
      (err, stdout) => {
        if (err || !stdout) return resolve('');
        resolve(stdout.trim().split('\n').slice(-40).join('\n').slice(-2000));
      },
    );
  });
}

/**
 * Locate pipeline.py whether running via ts-node (from src/) or compiled
 * (node dist/index.js, where __dirname is dist/ and the script lives in ../src).
 */
function resolvePipelineScript(): string {
  const candidates = [
    path.resolve(__dirname, 'pipeline.py'), // ts-node, or copied alongside dist
    path.resolve(__dirname, '../src/pipeline.py'), // compiled dist/ -> ../src
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function lastJsonLine(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{') && lines[i].endsWith('}')) return lines[i];
  }
  return null;
}

function guessImageExt(att: TrelloAttachment): string {
  const fromName = path.extname(att.name || '');
  if (fromName) return fromName;
  const fromUrl = path.extname(new URL(att.url).pathname);
  if (fromUrl) return fromUrl;
  if ((att.mimeType ?? '').includes('png')) return '.png';
  if ((att.mimeType ?? '').includes('jpeg')) return '.jpg';
  return '.png';
}

function guessVideoExt(att: TrelloAttachment): string {
  const fromName = path.extname(att.name || '');
  if (fromName) return fromName;
  try {
    const fromUrl = path.extname(new URL(att.url).pathname);
    if (fromUrl) return fromUrl;
  } catch {
    /* ignore */
  }
  if ((att.mimeType ?? '').includes('webm')) return '.webm';
  if ((att.mimeType ?? '').includes('quicktime')) return '.mov';
  return '.mp4';
}

/** Make a card title safe to use as a single filename. */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'episode').slice(0, 120);
}

/**
 * Validate that an extracted bundle is a COMPLETE episode (so we only reuse real,
 * finished output — never a partial one from a stalled run). Requires the final
 * images, audio, and the episode package; the MP4 too when video build is on.
 */
function isCompleteBundle(rootDir: string): boolean {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(e.name.toLowerCase());
    }
  };
  try {
    walk(rootDir);
  } catch {
    return false;
  }
  const images = files.filter((f) => /\.(png|jpe?g|webp)$/.test(f)).length;
  const hasAudio = files.some((f) => /\.(mp3|wav)$/.test(f));
  const hasPackage = files.includes('episode_package.json');
  const ok = images >= 15 && hasAudio && hasPackage;
  if (!ok) {
    log.info(`Bundle check: images=${images} audio=${hasAudio} package=${hasPackage}`);
  }
  return ok;
}

/**
 * If the extracted bundle has exactly one top-level directory and no top-level
 * files, return that inner directory so we don't nest an extra folder in Drive.
 */
function collapseSingleRoot(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(dir, entries[0].name);
  }
  return dir;
}
