/**
 * Test-edit job. A dashboard button sets `test_edit_status = 'queued'` (+ `test_edit_sec`)
 * on a completed episode; the watcher downloads that episode's bundle from its Drive folder
 * and builds the **first N seconds of the real edit** (edited intro + body, real per-image
 * durations — only the last still is clipped to land on N, so it looks exactly like the
 * final), uploads the MP4 back into the same Drive folder, and records the link.
 *
 * Self-contained: sources the bundle from Drive (not the studio), and builds via the same
 * `buildEditedVideo` the live "build video" pipeline uses. Needs Drive + ffmpeg + Trello.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as tmp from 'tmp';
import type { Episode } from '@slate/shared';
import { buildEditedVideo } from './editedVideo';
import { parseDriveFolderId } from './drive';
import { createLogger } from './logger';
import type { PipelineDeps } from './pipeline';

const log = createLogger('test-edit');

function sanitize(s: string): string {
  return s.replace(/[^\w.\- ]+/g, '_').slice(0, 80).trim() || 'episode';
}

/** Re-fetch the card's intro video attachment and download it; null (→ body only) if none. */
async function resolveIntroClip(ep: Episode, deps: PipelineDeps, dir: string): Promise<string | null> {
  if (!ep.trello_card_id) return null;
  let card;
  try {
    card = await deps.trello.getCard(ep.trello_card_id);
  } catch {
    log.warn(`Couldn't fetch Trello card ${ep.trello_card_id} for the intro — building body only`);
    return null;
  }
  const att = deps.trello.firstVideoAttachment(card);
  if (!att) {
    log.info('No intro video attachment on the card — building body only');
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname((att.url || '').split('?')[0]) || '.mp4';
  const clip = path.join(dir, `clip${ext}`);
  await deps.trello.downloadAttachment(att, clip);
  return clip;
}

/** The channel's intro-preset params for this episode, or null. */
async function resolvePresetParams(ep: Episode, deps: PipelineDeps): Promise<Record<string, unknown> | null> {
  if (!ep.channel_id) return null;
  const ch = await deps.store.getChannel(ep.channel_id).catch(() => null);
  if (!ch?.intro_preset_id) return null;
  return (await deps.store.getIntroPreset(ch.intro_preset_id).catch(() => null))?.params ?? null;
}

async function runOne(ep: Episode, deps: PipelineDeps): Promise<void> {
  const { drive, store } = deps;
  const sec = Math.max(10, ep.test_edit_sec ?? 180);
  const folderId = parseDriveFolderId(ep.drive_folder_url);
  if (!folderId) {
    throw new Error(`No Drive folder for "${ep.card_title}" (drive_folder_url=${ep.drive_folder_url ?? 'null'})`);
  }

  const work = tmp.dirSync({ prefix: 'slate-testedit-', unsafeCleanup: true });
  const stage = (s: string) => store.setTestEdit(ep.id, { stage: s }).catch(() => {});
  try {
    log.info(`Test edit "${ep.card_title}" — ${sec}s; downloading bundle from Drive folder ${folderId}`);
    stage('Downloading bundle');
    const bundle = path.join(work.name, 'bundle');
    // Skip videos (prior test edits / final MP4) — the edit only needs audio/images/package.
    await drive.downloadFolderContents(folderId, bundle, { skipExt: ['.mp4', '.mov', '.webm'] });

    const introClipPath = await resolveIntroClip(ep, deps, path.join(work.name, 'introsrc'));
    const presetParams = await resolvePresetParams(ep, deps);

    const out = path.join(work.name, `${sanitize(ep.card_title)} - test ${Math.round(sec / 60)}min.mp4`);
    await buildEditedVideo({
      bundleRoot: bundle,
      introClipPath,
      presetParams,
      maxSeconds: sec,
      outPath: out,
      workDir: path.join(work.name, 'edit'),
      onProgress: stage,
    });

    stage('Uploading to Drive');
    const url = await drive.uploadFileIntoFolder(out, folderId);
    await store.setTestEdit(ep.id, { status: 'done', url, stage: null });
    log.info(`✅ Test edit done for "${ep.card_title}" -> ${url}`);
  } finally {
    try {
      work.removeCallback();
    } catch {
      /* ignore */
    }
  }
}

let running = false;

/**
 * Drain all pending test edits, one at a time. Guarded so overlapping triggers
 * (realtime + cron + startup) don't run concurrently; re-checks for newly-queued
 * items before returning.
 */
export async function processPendingTestEdits(deps: PipelineDeps): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      let pending: Episode[];
      try {
        pending = await deps.store.getPendingTestEdits();
      } catch (err) {
        log.error('Failed to load pending test edits', err);
        return;
      }
      if (!pending.length) return;
      log.info(`${pending.length} test edit(s) pending`);
      for (const ep of pending) {
        try {
          await deps.store.setTestEdit(ep.id, { status: 'processing' });
          await runOne(ep, deps);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`❌ Test edit failed for "${ep.card_title}": ${msg}`);
          try {
            await deps.store.setTestEdit(ep.id, { status: 'failed', stage: null });
          } catch {
            /* ignore */
          }
        }
      }
    }
  } finally {
    running = false;
  }
}
