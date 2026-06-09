/**
 * Manually trigger the pipeline for a single hardcoded card, bypassing Trello
 * polling. Useful for verifying the Gradio → Drive → Supabase path end-to-end.
 *
 * Usage:
 *   pnpm --filter @slate/watcher test-pipeline
 *
 * Edit the TEST_CARD below (or set the SLATE_TEST_* env vars) to point at a
 * real reference image and brief. The image URL can be any publicly reachable
 * URL or a Trello attachment URL.
 */
import { loadConfig } from '../src/config';
import { buildDeps } from '../src/watcher';
import { runPipeline, type PipelineJob } from '../src/pipeline';
import type { TrelloAttachment } from '../src/trello';
import { createLogger } from '../src/logger';

const log = createLogger('test-pipeline');

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `ep_${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

// ── Edit these for your test, or export SLATE_TEST_* env vars ─────────────
const TEST_IMAGE_URL =
  process.env.SLATE_TEST_IMAGE_URL ??
  'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/480px-Cat03.jpg';
const TEST_CARD_TITLE = process.env.SLATE_TEST_TITLE ?? 'TEST — MTA Inspector Sal Cangelosi';
const TEST_BRIEF =
  process.env.SLATE_TEST_BRIEF ??
  'Test case brief: An MTA inspector is found unresponsive in a service tunnel. ' +
    'Bodycam footage recovered from responding officers. Reconstruct the events ' +
    'leading up to the incident for a documentary-style episode.';
const TEST_CARD_ID = process.env.SLATE_TEST_CARD_ID ?? `test_${Date.now()}`;
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const deps = buildDeps(cfg);

  const attachment: TrelloAttachment = {
    id: 'test-attachment',
    url: TEST_IMAGE_URL,
    name: 'reference.jpg',
    mimeType: 'image/jpeg',
    isUpload: false,
  };

  const job: PipelineJob = {
    cardId: TEST_CARD_ID,
    cardTitle: TEST_CARD_TITLE,
    brief: TEST_BRIEF,
    episodeName: stamp(),
    attachment,
    // Dummy channel context for the test. Set SLATE_TEST_DRIVE_FOLDER_ID to a
    // real Drive folder ID — the upload step now requires one.
    channel: {
      id: 'test-channel',
      name: 'TEST',
      driveFolderId: process.env.SLATE_TEST_DRIVE_FOLDER_ID ?? '',
    },
  };

  log.info(`Running test pipeline for "${job.cardTitle}" (${job.episodeName})`);
  log.info('NOTE: this writes a row to Supabase; Trello moves target a fake card.');

  // Insert a processing row so the dashboard shows the test run.
  await deps.store.insertProcessing({
    trelloCardId: job.cardId,
    cardTitle: job.cardTitle,
    episodeName: job.episodeName,
    channelId: null,
    channelName: 'TEST',
  });

  await runPipeline(job, deps);
  log.info('Test pipeline finished. Check Supabase / Drive for results.');
}

main().catch((err) => {
  log.error('Test pipeline crashed', err);
  process.exit(1);
});
