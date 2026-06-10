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
}

export interface PipelineJob {
  cardId: string;
  cardTitle: string;
  brief: string;
  episodeName: string;
  attachment: TrelloAttachment;
  channel: JobChannel;
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

  // Temp resources to clean up no matter what.
  let imageTmp: tmp.FileResult | null = null;
  let unzipDir: tmp.DirResult | null = null;

  // ── Pipeline timeline ──────────────────────────────────────────────
  // Ordered phases for this run (build-video only when enabled). Persisted to
  // Supabase and kept after the run so the dashboard can show a full stepper.
  const phaseDefs: { key: string; label: string }[] = [
    { key: 'Downloading reference', label: 'Reference image' },
    { key: 'Enhancing reference', label: 'Enhance reference' },
    { key: 'Generating script & assets', label: 'Script & assets' },
    ...(cfg.enableBuildVideo ? [{ key: 'Building video', label: 'Build video' }] : []),
    { key: 'Packaging files', label: 'Package files' },
    { key: 'Unpacking bundle', label: 'Unpack bundle' },
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

  // Upload to Drive, mark done, then move the card to the resolve list + comment
  // (best-effort). Shared by the normal and reuse paths.
  const uploadAndFinalize = async (rootDir: string): Promise<void> => {
    setStage('Uploading to Drive');
    const driveUrl = await drive.uploadEpisodeFolder(
      job.cardTitle,
      rootDir,
      job.channel.driveFolderId,
    );
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
    // 0. Reuse: probe for an already-complete bundle and skip generation if found.
    if (cfg.reuseExisting) {
      setStage('Checking for existing output');
      const probe = await runPythonPipeline(
        {
          episodeName: job.episodeName,
          brief: job.brief,
          imagePath: 'none',
          gradioUrl: cfg.gradio.baseUrl,
          enableBuildVideo: cfg.enableBuildVideo,
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
        if (isCompleteBundle(root, cfg.enableBuildVideo)) {
          log.info(`♻️  Reusing existing output for "${job.cardTitle}" — skipping generation`);
          await uploadAndFinalize(root);
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
        enableBuildVideo: cfg.enableBuildVideo,
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

    // 3. Unzip the bundle, then 4. upload + finalize.
    setStage('Unpacking bundle');
    const { dir, root } = unzipBundle(result.zip_path);
    unzipDir = dir;
    await uploadAndFinalize(root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`❌ Pipeline error for "${job.cardTitle}": ${message}`, err);
    // Best-effort failure recording — never let these throw out of here.
    try {
      await store.markFailed(job.cardId, message, timelineWith('failed'));
    } catch (e) {
      log.error('Failed to record failure in Supabase', e);
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
  enableBuildVideo: boolean;
  timeoutMin: number;
  downloadOnly: boolean;
}

/**
 * Spawn pipeline.py and resolve with the parsed PipelineResult. Rejects only
 * on spawn-level failures or unparseable output; pipeline logic failures come
 * back as { success: false } which the caller handles.
 *
 * Two safety nets: a HARD timeout (`pipelineTimeoutMs`) caps the whole run, and
 * a STALL watchdog fails fast if no PROGRESS update arrives for `stallTimeoutMs`
 * (so a wedged image/voiceover step surfaces clearly instead of hanging).
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
  if (args.enableBuildVideo) argv.push('--enable-build-video');
  if (args.downloadOnly) argv.push('--download-only');

  return new Promise<PyRunResult>((resolve) => {
    const child = spawn(pythonBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelTimer: ReturnType<typeof setInterval> | undefined;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    // Liveness for stall detection: bumped on every PROGRESS line.
    let lastProgressAt = Date.now();
    let lastProgressLabel = '';

    const tail = () => stderr.trim().split('\n').slice(-40).join('\n').slice(-1800);

    const cleanup = () => {
      clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (stallTimer) clearInterval(stallTimer);
    };

    const timer = setTimeout(() => {
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
          // Any new PROGRESS line means the pipeline is alive — reset the stall timer.
          lastProgressAt = Date.now();
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

/**
 * Validate that an extracted bundle is a COMPLETE episode (so we only reuse real,
 * finished output — never a partial one from a stalled run). Requires the final
 * images, audio, and the episode package; the MP4 too when video build is on.
 */
function isCompleteBundle(rootDir: string, requireVideo: boolean): boolean {
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
  const hasVideo = files.some((f) => /\.(mp4|mov|webm)$/.test(f));
  const ok = images >= 15 && hasAudio && hasPackage && (!requireVideo || hasVideo);
  if (!ok) {
    log.info(
      `Bundle check: images=${images} audio=${hasAudio} package=${hasPackage} video=${hasVideo}`,
    );
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
