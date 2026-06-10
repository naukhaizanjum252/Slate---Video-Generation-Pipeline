import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import * as tmp from 'tmp';
import type { PipelineResult, ProgressStep, PhaseStatus, TimelinePhase } from '@slate/shared';
import { createLogger } from './logger';
import { TrelloClient, type TrelloCard, type TrelloAttachment } from './trello';
import { DriveUploader } from './drive';
import { EpisodeStore } from './supabase';
import type { Config } from './config';

const log = createLogger('pipeline');

// Sentinel error returned by the python runner when a stop was requested, so the
// caller can mark the episode 'cancelled' rather than 'failed'.
const CANCEL_SENTINEL = '__SLATE_CANCELLED__';
// How often to poll Supabase for a stop request while a pipeline runs.
const CANCEL_POLL_MS = 10000;
// Min gap between stage writes to Supabase (coalesces rapid progress updates).
const STAGE_WRITE_MS = 3000;

// Episodes take ~15–25 min end-to-end (Opus script, Gemini enhance, 69labs
// images in ~4 rounds of 4 + voiceover, FFmpeg 1080p stitch). Give the python
// child 35 min so a slow run is never killed prematurely.
const PY_TIMEOUT_MS = 35 * 60 * 1000;

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

  try {
    // 1. Download the Trello reference image to a temp file.
    setStage('Downloading reference');
    const ext = guessImageExt(job.attachment);
    imageTmp = tmp.fileSync({ prefix: 'slate-ref-', postfix: ext });
    await trello.downloadAttachment(job.attachment, imageTmp.name);

    // 2. Spawn pipeline.py and parse its JSON result. onProgress relays the
    //    live stage; the cancel poller kills the child if a stop is requested.
    const result = await runPythonPipeline(
      {
        episodeName: job.episodeName,
        brief: job.brief,
        imagePath: imageTmp.name,
        gradioUrl: cfg.gradio.baseUrl,
        enableBuildVideo: cfg.enableBuildVideo,
      },
      cfg.pythonBin,
      setStage,
      () => store.isCancelRequested(job.cardId),
    );

    if (!result.success) {
      if (result.error === CANCEL_SENTINEL) {
        await store.markCancelled(job.cardId, timelineWith('active'));
        log.info(`🛑 Cancelled "${job.cardTitle}" (${job.episodeName})`);
        return;
      }
      throw new Error(`Pipeline failed: ${result.error}`);
    }

    // Honor a stop requested after generation finished but before upload.
    if (await store.isCancelRequested(job.cardId)) {
      await store.markCancelled(job.cardId, timelineWith('active'));
      log.info(`🛑 Cancelled "${job.cardTitle}" before upload`);
      return;
    }

    // 3. Unzip the bundle (gradio_client returns a local zip path).
    setStage('Unpacking bundle');
    if (!fs.existsSync(result.zip_path)) {
      throw new Error(`Zip path does not exist on disk: ${result.zip_path}`);
    }
    unzipDir = tmp.dirSync({ prefix: 'slate-bundle-', unsafeCleanup: true });
    new AdmZip(result.zip_path).extractAllTo(unzipDir.name, /* overwrite */ true);
    log.info(`Unzipped bundle -> ${unzipDir.name}`);

    // The zip may contain a single top-level folder; upload its contents.
    const rootToUpload = collapseSingleRoot(unzipDir.name);

    // 4. Upload to the channel's Google Drive folder (mandatory per channel).
    setStage('Uploading to Drive');
    const driveUrl = await drive.uploadEpisodeFolder(
      job.cardTitle,
      rootToUpload,
      job.channel.driveFolderId,
    );

    // 5. Mark done in Supabase, then move the card to the channel's resolve list
    //    and post the Drive link as a comment (best-effort — never fail a done).
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
}

/**
 * Spawn pipeline.py and resolve with the parsed PipelineResult. Rejects only
 * on spawn-level failures or unparseable output; pipeline logic failures come
 * back as { success: false } which the caller handles. `onProgress` receives
 * each "PROGRESS <stage>" line pipeline.py emits.
 */
function runPythonPipeline(
  args: PyArgs,
  pythonBin: string,
  onProgress?: (phase: string, steps: ProgressStep[]) => void,
  isCancelRequested?: () => Promise<boolean>,
): Promise<PipelineResult> {
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
  ];
  if (args.enableBuildVideo) argv.push('--enable-build-video');

  return new Promise<PipelineResult>((resolve, reject) => {
    const child = spawn(pythonBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`pipeline.py timed out after ${PY_TIMEOUT_MS / 1000}s`));
    }, PY_TIMEOUT_MS);

    // Poll for a dashboard stop request; if seen, kill the child and resolve
    // with the cancel sentinel so the caller marks the episode 'cancelled'.
    if (isCancelRequested) {
      cancelTimer = setInterval(() => {
        if (settled) return;
        isCancelRequested()
          .then((wantStop) => {
            if (!wantStop || settled) return;
            settled = true;
            cleanup();
            child.kill('SIGKILL');
            resolve({ success: false, error: CANCEL_SENTINEL });
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
        if (m && onProgress) {
          try {
            const parsed = JSON.parse(m[1]) as { phase?: string; steps?: ProgressStep[] };
            if (parsed && typeof parsed.phase === 'string') {
              onProgress(parsed.phase, Array.isArray(parsed.steps) ? parsed.steps : []);
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
      reject(new Error(`Failed to spawn ${pythonBin}: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            `pipeline.py produced no stdout (exit ${code}). stderr: ${stderr.slice(-2000)}`,
          ),
        );
        return;
      }
      // The contract is a single JSON line; take the last JSON-looking line
      // to be robust against any stray prints.
      const jsonLine = lastJsonLine(trimmed);
      if (!jsonLine) {
        reject(new Error(`Could not find JSON in pipeline.py stdout: ${trimmed.slice(-2000)}`));
        return;
      }
      try {
        resolve(JSON.parse(jsonLine) as PipelineResult);
      } catch (e) {
        reject(new Error(`Invalid JSON from pipeline.py: ${jsonLine}`));
      }
    });
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
