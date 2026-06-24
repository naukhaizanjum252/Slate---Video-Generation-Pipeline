import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Channel, Episode, EpisodeStatus, IntroPreset, ProgressStep, TimelinePhase } from '@slate/shared';
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

  /**
   * Fetch the connected Google account's Drive refresh token (set from the
   * dashboard). Returns null when no account has been connected there yet, so
   * the caller can fall back to the env value. Never throws — a transient
   * lookup failure shouldn't block falling back.
   */
  async getDriveRefreshToken(): Promise<string | null> {
    const { data, error } = await this.client
      .from('drive_auth')
      .select('refresh_token')
      .eq('id', true)
      .maybeSingle();
    if (error) {
      log.warn(`Drive auth lookup failed (falling back to env): ${error.message}`);
      return null;
    }
    return data?.refresh_token ?? null;
  }

  /** Fetch one channel by id (used to resolve the intro preset for a test edit). */
  async getChannel(id: string): Promise<Channel | null> {
    const { data, error } = await this.client.from('channels').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`Supabase channel lookup failed: ${error.message}`);
    return (data as Channel) ?? null;
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

  /**
   * Claim a card for processing. If a row already exists for the card (a `queued`
   * retry), it's UPDATED in place — clearing stale failure/output fields — so the
   * dashboard row never disappears. Otherwise a fresh row is inserted.
   */
  async insertProcessing(params: {
    trelloCardId: string;
    cardTitle: string;
    episodeName: string;
    channelId?: string | null;
    channelName?: string | null;
  }): Promise<Episode> {
    const base = {
      card_title: params.cardTitle,
      episode_name: params.episodeName,
      status: 'processing' as EpisodeStatus,
      stage: 'Queued',
      progress: null,
      channel_id: params.channelId ?? null,
      channel_name: params.channelName ?? null,
    };
    const { data: existing } = await this.client
      .from('episodes')
      .select('id')
      .eq('trello_card_id', params.trelloCardId)
      .maybeSingle();
    if (existing) {
      const { data, error } = await this.client
        .from('episodes')
        .update({
          ...base,
          error_message: null,
          drive_folder_url: null,
          timeline: null,
          completed_at: null,
          cancel_requested: false,
        })
        .eq('trello_card_id', params.trelloCardId)
        .select()
        .single();
      if (error) throw new Error(`Supabase reclaim failed: ${error.message}`);
      log.info(`Re-claimed episode ${params.episodeName} (card ${params.trelloCardId})`);
      return data as Episode;
    }
    const { data, error } = await this.client
      .from('episodes')
      .insert({ trello_card_id: params.trelloCardId, ...base })
      .select()
      .single();
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    log.info(`Inserted episode ${params.episodeName} (card ${params.trelloCardId})`);
    return data as Episode;
  }

  /** Current status for a card's episode row, or null if none exists. */
  async statusForCard(trelloCardId: string): Promise<EpisodeStatus | null> {
    const { data, error } = await this.client
      .from('episodes')
      .select('status')
      .eq('trello_card_id', trelloCardId)
      .maybeSingle();
    if (error) throw new Error(`Supabase status lookup failed: ${error.message}`);
    return (data?.status as EpisodeStatus) ?? null;
  }

  /**
   * Subscribe to Supabase Realtime for episodes flipping to `queued` (a dashboard
   * retry) so the watcher can act instantly instead of waiting for the next poll.
   * Fires `onQueued` on each matching INSERT/UPDATE. Requires the `episodes` table
   * to be in the `supabase_realtime` publication with REPLICA IDENTITY FULL (see
   * supabase-schema.sql). Safe to call once at startup; supabase-js auto-rejoins.
   */
  subscribeToQueued(onQueued: () => void): void {
    this.client
      .channel('slate-queued')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'episodes', filter: 'status=eq.queued' },
        () => onQueued(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'episodes', filter: 'status=eq.queued' },
        () => onQueued(),
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') log.info('Realtime: watching for queued retries (instant pickup)');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
          log.warn(`Realtime subscription ${status} — retries will fall back to the poll interval`);
      });
  }

  /* ── Intro presets ── */

  async listIntroPresets(): Promise<IntroPreset[]> {
    const { data, error } = await this.client
      .from('intro_presets')
      .select('id, name, channel, params')
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Supabase preset list failed: ${error.message}`);
    return (data ?? []) as IntroPreset[];
  }

  async getIntroPreset(id: string): Promise<IntroPreset | null> {
    const { data, error } = await this.client
      .from('intro_presets')
      .select('id, name, channel, params')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`Supabase preset lookup failed: ${error.message}`);
    return (data as IntroPreset) ?? null;
  }

  async createIntroPreset(p: { name: string; channel: string; params: Record<string, unknown> }): Promise<IntroPreset> {
    const { data, error } = await this.client
      .from('intro_presets')
      .insert({ name: p.name, channel: p.channel, params: p.params })
      .select('id, name, channel, params')
      .single();
    if (error) throw new Error(`Supabase preset create failed: ${error.message}`);
    return data as IntroPreset;
  }

  async deleteIntroPreset(id: string): Promise<void> {
    const { error } = await this.client.from('intro_presets').delete().eq('id', id);
    if (error) throw new Error(`Supabase preset delete failed: ${error.message}`);
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

  /* ── Test edits ── */

  /** Episodes the dashboard requested a test edit for (test_edit_status = 'queued'). */
  async getPendingTestEdits(): Promise<Episode[]> {
    const { data, error } = await this.client
      .from('episodes')
      .select('*')
      .eq('test_edit_status', 'queued')
      .order('created_at', { ascending: true });
    if (error) throw new Error(`Supabase getPendingTestEdits failed: ${error.message}`);
    return (data ?? []) as Episode[];
  }

  /** Update a test edit's lifecycle, current stage, and/or the resulting Drive URL. */
  async setTestEdit(id: string, fields: { status?: string; url?: string | null; stage?: string | null }): Promise<void> {
    const update: Record<string, unknown> = {};
    if (fields.status !== undefined) update.test_edit_status = fields.status;
    if (fields.url !== undefined) update.test_edit_url = fields.url;
    if (fields.stage !== undefined) update.test_edit_stage = fields.stage;
    if (!Object.keys(update).length) return;
    const { error } = await this.client.from('episodes').update(update).eq('id', id);
    if (error) throw new Error(`Supabase setTestEdit failed: ${error.message}`);
  }

  /** Realtime: fire when an episode's test_edit_status flips to 'queued'. */
  subscribeToTestEdits(onRequest: () => void): void {
    this.client
      .channel('slate-test-edits')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'episodes', filter: 'test_edit_status=eq.queued' },
        () => onRequest(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'episodes', filter: 'test_edit_status=eq.queued' },
        () => onRequest(),
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') log.info('Realtime: watching for test-edit requests');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
          log.warn(`Realtime test-edit subscription ${status} — falling back to poll`);
      });
  }
}
