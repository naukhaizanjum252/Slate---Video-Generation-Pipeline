import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Channel, Episode, EpisodeStatus, ProgressStep, TimelinePhase } from '@slate/shared';
import { createLogger } from './logger';
import type { Config } from './config';

const log = createLogger('supabase');

export class EpisodeStore {
  private readonly client: SupabaseClient;

  constructor(cfg: Config['supabase']) {
    this.client = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** Fetch all enabled channels to poll. */
  async getEnabledChannels(): Promise<Channel[]> {
    const { data, error } = await this.client
      .from('channels')
      .select('*')
      .eq('enabled', true)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`Supabase channels lookup failed: ${error.message}`);
    return (data ?? []) as Channel[];
  }

  /** Insert a new processing row. Returns the created episode. */
  async insertProcessing(params: {
    trelloCardId: string;
    cardTitle: string;
    episodeName: string;
    channelId?: string | null;
    channelName?: string | null;
  }): Promise<Episode> {
    const { data, error } = await this.client
      .from('episodes')
      .insert({
        trello_card_id: params.trelloCardId,
        card_title: params.cardTitle,
        episode_name: params.episodeName,
        status: 'processing' as EpisodeStatus,
        stage: 'Queued',
        progress: null,
        channel_id: params.channelId ?? null,
        channel_name: params.channelName ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    log.info(`Inserted episode ${params.episodeName} (card ${params.trelloCardId})`);
    return data as Episode;
  }

  /** Has the dashboard requested this card be stopped? */
  async isCancelRequested(trelloCardId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('episodes')
      .select('cancel_requested')
      .eq('trello_card_id', trelloCardId)
      .maybeSingle();
    if (error) throw new Error(`Supabase cancel lookup failed: ${error.message}`);
    return data?.cancel_requested === true;
  }

  /** Mark a card cancelled (clears the request flag + live stage). */
  async markCancelled(trelloCardId: string, timeline?: TimelinePhase[]): Promise<void> {
    const update: Record<string, unknown> = {
      status: 'cancelled' as EpisodeStatus,
      stage: null,
      progress: null,
      cancel_requested: false,
      completed_at: new Date().toISOString(),
    };
    if (timeline) update.timeline = timeline;
    const { error } = await this.client
      .from('episodes')
      .update(update)
      .eq('trello_card_id', trelloCardId);
    if (error) throw new Error(`Supabase markCancelled failed: ${error.message}`);
    log.info(`Marked card ${trelloCardId} cancelled`);
  }

  /** Update the live phase + concurrent sub-steps + full timeline. */
  async updateStage(
    trelloCardId: string,
    stage: string,
    progress: ProgressStep[],
    timeline?: TimelinePhase[],
  ): Promise<void> {
    const update: Record<string, unknown> = { stage, progress };
    if (timeline) update.timeline = timeline;
    const { error } = await this.client
      .from('episodes')
      .update(update)
      .eq('trello_card_id', trelloCardId);
    if (error) throw new Error(`Supabase updateStage failed: ${error.message}`);
  }

  /** Has this Trello card already been recorded? Guards against re-triggering. */
  async existsForCard(trelloCardId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('episodes')
      .select('id')
      .eq('trello_card_id', trelloCardId)
      .maybeSingle();
    if (error) throw new Error(`Supabase lookup failed: ${error.message}`);
    return data !== null;
  }

  async markDone(
    trelloCardId: string,
    driveFolderUrl: string,
    timeline?: TimelinePhase[],
  ): Promise<void> {
    const update: Record<string, unknown> = {
      status: 'done' as EpisodeStatus,
      drive_folder_url: driveFolderUrl,
      completed_at: new Date().toISOString(),
      error_message: null,
      stage: null,
      progress: null,
    };
    if (timeline) update.timeline = timeline;
    const { error } = await this.client
      .from('episodes')
      .update(update)
      .eq('trello_card_id', trelloCardId);
    if (error) throw new Error(`Supabase markDone failed: ${error.message}`);
    log.info(`Marked card ${trelloCardId} done`);
  }

  async markFailed(
    trelloCardId: string,
    errorMessage: string,
    timeline?: TimelinePhase[],
  ): Promise<void> {
    const update: Record<string, unknown> = {
      status: 'failed' as EpisodeStatus,
      error_message: errorMessage.slice(0, 2000),
      completed_at: new Date().toISOString(),
      stage: null,
      progress: null,
    };
    if (timeline) update.timeline = timeline;
    const { error } = await this.client
      .from('episodes')
      .update(update)
      .eq('trello_card_id', trelloCardId);
    if (error) throw new Error(`Supabase markFailed failed: ${error.message}`);
    log.info(`Marked card ${trelloCardId} failed`);
  }
}
