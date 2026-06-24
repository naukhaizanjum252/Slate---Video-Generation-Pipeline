import * as fs from 'fs';
import * as cron from 'node-cron';
import { createLogger } from './logger';
import { loadConfig, type Config } from './config';
import { TrelloClient, type TrelloCard } from './trello';
import { DriveUploader } from './drive';
import { EpisodeStore } from './supabase';
import type { Channel } from '@slate/shared';
import { runPipeline, type PipelineDeps, type PipelineJob, type JobChannel } from './pipeline';
import { parseEffect, parseSubjectName } from './effects';
import { startIntroEditor } from './introEditor';
import { processPendingTestEdits } from './testEdit';

const log = createLogger('watcher');

/**
 * Bounded-concurrency processing model.
 *
 * Up to `cfg.maxConcurrentEpisodes` pipelines run at once, fed by a FIFO queue;
 * a new job starts as soon as a slot frees up. This MUST stay within the
 * upstream 69labs / studio caps — each episode uses ~4 concurrent image jobs (so
 * N episodes need ~4N image slots) plus voiceover/script calls.
 *
 * - `claimed` — card IDs pulled off a Trello source list (recorded in Supabase)
 *   and either waiting in `queue` or actively running. Stops the same card being
 *   enqueued twice across cron ticks.
 * - `queue`       — pending jobs, started in arrival order.
 * - `activeCount` — pipelines currently running.
 * - Supabase's unique `trello_card_id` is the durable cross-restart guard.
 */
const claimed = new Set<string>();
const queue: PipelineJob[] = [];
let activeCount = 0;

/**
 * Start as many queued jobs as the concurrency budget allows, then return. Each
 * job re-invokes pump() when it finishes so the next one starts immediately.
 */
function pump(deps: PipelineDeps): void {
  while (activeCount < deps.cfg.maxConcurrentEpisodes && queue.length > 0) {
    const job = queue.shift() as PipelineJob;
    activeCount++;
    void runJob(job, deps).finally(() => {
      activeCount--;
      pump(deps); // a slot freed — pull the next job
    });
  }
}

/**
 * Process one job. Self-contained and never throws — runPipeline records its own
 * failures; this just guards the claim bookkeeping.
 */
async function runJob(job: PipelineJob, deps: PipelineDeps): Promise<void> {
  try {
    // Honor a stop requested while the job was still waiting in the queue.
    if (await deps.store.isCancelRequested(job.cardId)) {
      await deps.store.markCancelled(job.cardId);
      log.info(`🛑 Cancelled "${job.cardTitle}" before it started`);
      return;
    }
    log.info(
      `Processing "${job.cardTitle}" (${job.episodeName}) — ${activeCount} running, ${queue.length} queued`,
    );
    await runPipeline(job, deps);
  } catch (err) {
    log.error(`Worker error on "${job.cardTitle}"`, err);
  } finally {
    claimed.delete(job.cardId);
  }
}

/**
 * Derive a server-safe episode name (ep_YYYYMMDD_HHMMSS) from the card.
 * Prefers dateLastActivity; falls back to the timestamp embedded in the
 * Trello/Mongo object id (first 8 hex chars = unix seconds).
 */
export function episodeNameFromCard(card: TrelloCard): string {
  let date: Date;
  const fromActivity = card.dateLastActivity ? new Date(card.dateLastActivity) : null;
  if (fromActivity && !isNaN(fromActivity.getTime())) {
    date = fromActivity;
  } else {
    const seconds = parseInt(card.id.substring(0, 8), 16);
    date = Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
  }
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `_${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
  return `ep_${stamp}`;
}

/**
 * One poll cycle: load every enabled channel, scan each channel's Trello queue
 * list, claim new cards (move + insert) synchronously, then ENQUEUE them for the
 * single sequential worker. The cron loop never blocks on a running pipeline —
 * it just discovers and queues — while the worker processes episodes one at a
 * time (across ALL channels) to respect the 69labs concurrency cap.
 */
export async function pollOnce(deps: PipelineDeps): Promise<void> {
  const { store } = deps;
  let channels: Channel[];
  try {
    channels = await store.getEnabledChannels();
  } catch (err) {
    log.error('Failed to load channels (will retry next tick)', err);
    return;
  }

  if (channels.length === 0) {
    log.info('No enabled channels configured — add one in the dashboard Settings page');
    return;
  }

  for (const channel of channels) {
    await pollChannel(channel, deps);
  }
}

/** Scan a single channel's source list and enqueue any new cards. */
async function pollChannel(channel: Channel, deps: PipelineDeps): Promise<void> {
  const { trello, store } = deps;
  let cards: TrelloCard[];
  try {
    cards = await trello.getCardsInList(channel.trello_source_list_id);
  } catch (err) {
    log.error(`[${channel.name}] Failed to fetch source cards (will retry)`, err);
    return;
  }

  if (cards.length === 0) return;
  // No per-tick "found N cards" log — it's noisy since cards stay in the source
  // list. New cards are logged individually when queued below.

  for (const card of cards) {
    if (claimed.has(card.id)) continue;

    try {
      // Cards are never moved out of the source list, so de-dupe is entirely
      // Supabase-driven: skip cards we've already recorded. EXCEPTION: a `queued`
      // row is a dashboard-requested retry — fall through and reprocess it in place
      // (insertProcessing updates the existing row, so the dashboard row never
      // vanishes the way deleting + re-inserting did).
      const existingStatus = await store.statusForCard(card.id);
      if (existingStatus && existingStatus !== 'queued') {
        continue;
      }

      const jobChannel: JobChannel = {
        id: channel.id,
        name: channel.name,
        driveFolderId: channel.drive_folder_id,
        resolveListId: channel.trello_resolve_list_id,
        videoMode: channel.video_mode === true,
        editIntroOnly: channel.edit_intro_only === true,
        introPresetId: channel.intro_preset_id ?? null,
      };
      const episodeName = episodeNameFromCard(card);

      // Parse the optional effect directive out of the description; the cleaned
      // brief (directive removed) is what we send on for generation. In video
      // mode, also grab the first video attachment as the intro to prepend.
      const { effectTimestampSec, cleanedBrief } = parseEffect(card.desc ?? '');
      // Intro-only edits the card's VIDEO attachment (no studio generation).
      const introOnly = jobChannel.videoMode && jobChannel.editIntroOnly;
      const wantsIntro = jobChannel.videoMode || jobChannel.editIntroOnly;
      const introAttachment = wantsIntro ? trello.firstVideoAttachment(card) : null;
      const voiceoverAttachment = jobChannel.editIntroOnly ? trello.firstAudioAttachment(card) : null;
      const captionsAttachment = jobChannel.editIntroOnly ? trello.firstSubtitleAttachment(card) : null;
      const subjectName = jobChannel.editIntroOnly ? parseSubjectName(card.desc ?? '') : null;

      // Intro-only needs the video attachment (no reference image); every other
      // mode needs the reference image to generate from.
      const imageAttachment = trello.firstImageAttachment(card);
      if (introOnly ? !introAttachment : !imageAttachment) {
        const reason = introOnly
          ? 'No video attachment on card for intro-only build'
          : 'No reference image attachment on card';
        log.warn(`[${channel.name}] Card "${card.name}" — ${reason}`);
        await store.insertProcessing({
          trelloCardId: card.id,
          cardTitle: card.name,
          episodeName,
          channelId: channel.id,
          channelName: channel.name,
        });
        await store.markFailed(card.id, reason);
        continue;
      }
      const attachment = (imageAttachment ?? introAttachment)!;

      // Claim the card in Supabase BEFORE running the pipeline so a restart
      // won't re-trigger it (the row's existence is the durable guard).
      await store.insertProcessing({
        trelloCardId: card.id,
        cardTitle: card.name,
        episodeName,
        channelId: channel.id,
        channelName: channel.name,
      });

      const job: PipelineJob = {
        cardId: card.id,
        cardTitle: card.name,
        brief: cleanedBrief,
        episodeName,
        attachment,
        channel: jobChannel,
        introAttachment,
        voiceoverAttachment,
        captionsAttachment,
        subjectName,
        effectTimestampSec,
      };

      // Enqueue and kick the dispatcher. It starts the job immediately if a
      // concurrency slot is free, otherwise it waits its turn in the queue.
      claimed.add(card.id);
      queue.push(job);
      log.info(
        `[${channel.name}] Queued "${card.name}" (${episodeName}) — position ${queue.length} in queue`,
      );
      pump(deps);
    } catch (err) {
      // Claiming failed (e.g. Trello/Supabase hiccup). The card stays in the
      // source list and is retried next tick. Never crash the loop.
      log.error(`[${channel.name}] Failed to claim card "${card.name}" (${card.id})`, err);
    }
  }
}

/** Build all external clients from validated config. */
export function buildDeps(cfg: Config): PipelineDeps {
  const store = new EpisodeStore(cfg.supabase);
  // Drive token: prefer the account connected from the dashboard (Supabase),
  // fall back to the env value. Resolved per upload so account switches in the
  // dashboard take effect without restarting the watcher.
  const getRefreshToken = async (): Promise<string> => {
    const fromDb = await store.getDriveRefreshToken();
    return fromDb || cfg.google.oauthRefreshToken || '';
  };
  return {
    cfg,
    trello: new TrelloClient(cfg.trello),
    drive: new DriveUploader(cfg.google, getRefreshToken),
    store,
  };
}

/** Start the cron-driven watcher. */
export function startWatcher(): void {
  const cfg = loadConfig();
  const deps = buildDeps(cfg);

  log.info('Slate watcher starting');
  log.info(`Polling enabled channels' Trello queues on "${cfg.pollCron}"`);
  log.info(`Processing up to ${cfg.maxConcurrentEpisodes} episode(s) concurrently`);

  // Optionally run the intro editor in-process. It needs ffmpeg (which lives here,
  // not on Vercel), so the dashboard's "Intro Editor" tab points at this server
  // (NEXT_PUBLIC_INTRO_EDITOR_URL) instead of running its own copy.
  if (process.env.INTRO_EDITOR === 'true') {
    try {
      startIntroEditor({
        host: process.env.INTRO_EDITOR_HOST || '0.0.0.0',
        port: Number(process.env.INTRO_EDITOR_PORT) || 5174,
        store: deps.store,
      });
    } catch (err) {
      log.error('Failed to start the in-process intro editor', err);
    }
  }

  // Single guarded entry point so the cron, the startup poll, and the realtime
  // trigger never overlap (a poll just discovers + enqueues; it returns fast).
  let running = false;
  const triggerPoll = async (reason: string) => {
    if (running) return;
    running = true;
    try {
      await pollOnce(deps);
    } catch (err) {
      log.error(`Unexpected error in poll cycle (${reason})`, err);
    } finally {
      running = false;
    }
  };

  cron.schedule(cfg.pollCron, () => void triggerPoll('cron'));

  // Instant retry pickup: when a dashboard retry flips a row to `queued`, Supabase
  // Realtime fires and we poll immediately instead of waiting for the next tick.
  // Debounced so a burst of changes collapses into one poll; if realtime is down
  // the cron still picks retries up at the normal interval.
  let kickTimer: ReturnType<typeof setTimeout> | null = null;
  deps.store.subscribeToQueued(() => {
    if (kickTimer) return;
    kickTimer = setTimeout(() => {
      kickTimer = null;
      void triggerPoll('realtime');
    }, 400);
  });

  // Test edits: a dashboard button flips test_edit_status to `queued`. Pick it up
  // instantly via Realtime (debounced), with the cron tick as a fallback. The
  // processor is self-guarded so overlapping triggers never run concurrently.
  let testKick: ReturnType<typeof setTimeout> | null = null;
  deps.store.subscribeToTestEdits(() => {
    if (testKick) return;
    testKick = setTimeout(() => {
      testKick = null;
      void processPendingTestEdits(deps);
    }, 400);
  });
  cron.schedule(cfg.pollCron, () => void processPendingTestEdits(deps));

  // Daily cleanup of Gradio temp files to prevent disk exhaustion.
  // The Gradio tool accumulates files in /tmp/gradio — previously caused
  // 40GB of disk usage. Runs at 3:00 AM UTC every day.
  cron.schedule('0 3 * * *', () => {
    const gradioTmp = '/tmp/gradio';
    if (!fs.existsSync(gradioTmp)) return;
    log.info('Running daily /tmp/gradio cleanup');
    try {
      const entries = fs.readdirSync(gradioTmp);
      let cleaned = 0;
      for (const entry of entries) {
        const fullPath = `${gradioTmp}/${entry}`;
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          cleaned++;
        } catch (e) {
          log.warn(`Could not remove ${fullPath}`, e);
        }
      }
      log.info(`Cleaned ${cleaned} entries from /tmp/gradio`);
    } catch (err) {
      log.error('Failed to clean /tmp/gradio', err);
    }
  });

  // Run an immediate first poll so we don't wait a full interval on boot.
  void triggerPoll('startup');
  // Drain any test edits requested while the watcher was down.
  void processPendingTestEdits(deps);
}
