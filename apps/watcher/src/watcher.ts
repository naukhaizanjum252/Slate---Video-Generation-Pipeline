import * as fs from 'fs';
import * as cron from 'node-cron';
import { createLogger } from './logger';
import { loadConfig, type Config } from './config';
import { TrelloClient, type TrelloCard } from './trello';
import { DriveUploader } from './drive';
import { EpisodeStore } from './supabase';
import type { Channel } from '@slate/shared';
import { runPipeline, type PipelineDeps, type PipelineJob, type JobChannel } from './pipeline';

const log = createLogger('watcher');

/**
 * Sequential processing model.
 *
 * 69labs caps us at 4 concurrent image jobs, and each episode already uses that
 * full budget (16 images in ~4 rounds of 4). Running two episodes at once would
 * double that and blow the cap — so episodes are processed strictly ONE AT A
 * TIME through a single in-process worker fed by a FIFO queue.
 *
 * - `claimed` — card IDs pulled off the Trello queue (moved to Processing +
 *   recorded in Supabase) and either waiting in `queue` or actively running.
 *   Stops the same card being enqueued twice across cron ticks.
 * - `queue`   — pending jobs, processed in arrival order.
 * - Supabase's unique `trello_card_id` is the durable cross-restart guard.
 */
const claimed = new Set<string>();
const queue: PipelineJob[] = [];
let workerRunning = false;

/**
 * Drain the queue one job at a time. Each pipeline is fully awaited before the
 * next starts, keeping us within the 69labs concurrency cap. Self-contained and
 * never throws — runPipeline records its own failures.
 */
async function drainQueue(deps: PipelineDeps): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift() as PipelineJob;
      try {
        // Honor a stop requested while the job was still waiting in the queue.
        if (await deps.store.isCancelRequested(job.cardId)) {
          await deps.store.markCancelled(job.cardId);
          log.info(`🛑 Cancelled "${job.cardTitle}" before it started`);
          continue;
        }
        log.info(
          `Processing "${job.cardTitle}" (${job.episodeName}) — ${queue.length} still queued`,
        );
        await runPipeline(job, deps);
      } finally {
        claimed.delete(job.cardId);
      }
    }
  } finally {
    workerRunning = false;
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
      // Supabase-driven: if we've already recorded this card, skip it. This is
      // what stops the same card being reprocessed every poll.
      if (await store.existsForCard(card.id)) {
        // Already handled (processing/done/failed) — quietly skip.
        continue;
      }

      const jobChannel: JobChannel = {
        id: channel.id,
        name: channel.name,
        driveFolderId: channel.drive_folder_id,
        resolveListId: channel.trello_resolve_list_id,
      };
      const episodeName = episodeNameFromCard(card);

      const attachment = trello.firstImageAttachment(card);
      if (!attachment) {
        log.warn(`[${channel.name}] Card "${card.name}" has no image — recording as failed`);
        // Record as failed so it isn't retried every tick.
        await store.insertProcessing({
          trelloCardId: card.id,
          cardTitle: card.name,
          episodeName,
          channelId: channel.id,
          channelName: channel.name,
        });
        await store.markFailed(card.id, 'No reference image attachment on card');
        continue;
      }

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
        brief: card.desc ?? '',
        episodeName,
        attachment,
        channel: jobChannel,
      };

      // Enqueue for the single sequential worker and kick it. The worker runs
      // jobs one at a time; if it's already running, this just adds to the tail.
      claimed.add(card.id);
      queue.push(job);
      log.info(
        `[${channel.name}] Queued "${card.name}" (${episodeName}) — position ${queue.length} in queue`,
      );
      void drainQueue(deps).catch((err) => log.error('Worker crashed', err));
    } catch (err) {
      // Claiming failed (e.g. Trello/Supabase hiccup). The card stays in the
      // source list and is retried next tick. Never crash the loop.
      log.error(`[${channel.name}] Failed to claim card "${card.name}" (${card.id})`, err);
    }
  }
}

/** Build all external clients from validated config. */
export function buildDeps(cfg: Config): PipelineDeps {
  return {
    cfg,
    trello: new TrelloClient(cfg.trello),
    drive: new DriveUploader(cfg.google),
    store: new EpisodeStore(cfg.supabase),
  };
}

/** Start the cron-driven watcher. */
export function startWatcher(): void {
  const cfg = loadConfig();
  const deps = buildDeps(cfg);

  log.info('Slate watcher starting');
  log.info(`Polling enabled channels' Trello queues on "${cfg.pollCron}"`);

  // Prevent overlapping ticks from stacking up if a poll runs long.
  let running = false;
  cron.schedule(cfg.pollCron, async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(deps);
    } catch (err) {
      log.error('Unexpected error in poll cycle', err);
    } finally {
      running = false;
    }
  });

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
  void pollOnce(deps).catch((err) => log.error('Initial poll failed', err));
}
