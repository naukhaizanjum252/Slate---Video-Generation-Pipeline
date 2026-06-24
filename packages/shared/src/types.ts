export type EpisodeStatus = 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';

/** One concurrent sub-task of the current phase (e.g. Images, Voiceover). */
export interface ProgressStep {
  label: string;
  text: string;
}

export type PhaseStatus = 'pending' | 'active' | 'done' | 'failed';

/**
 * One phase in an episode's pipeline timeline. Persisted (and kept after the run
 * finishes) so the dashboard can show a full stepper, including what each step
 * achieved. `steps` holds parallel sub-tasks (Script / Images / Voiceover).
 */
export interface TimelinePhase {
  key: string;
  label: string;
  status: PhaseStatus;
  steps?: ProgressStep[];
}

export interface Episode {
  id: string;
  trello_card_id: string;
  card_title: string;
  episode_name: string;
  status: EpisodeStatus;
  drive_folder_url: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  channel_id: string | null;
  channel_name: string | null;
  /** Live high-level phase while processing (e.g. "Generating script & assets"). */
  stage: string | null;
  /** Concurrent sub-tasks of the current phase, each with its own status text. */
  progress: ProgressStep[] | null;
  /** Full per-phase pipeline timeline; persists after the run for history. */
  timeline: TimelinePhase[] | null;
  /** Set by the dashboard's Stop button; the watcher acts on it and cancels. */
  cancel_requested: boolean;
  /** Test-edit: requested duration in seconds (set by the dashboard button). */
  test_edit_sec: number | null;
  /** Test-edit lifecycle: 'queued' | 'processing' | 'done' | 'failed' | null. */
  test_edit_status: string | null;
  /** Drive link to the produced test edit (the episode folder it was uploaded into). */
  test_edit_url: string | null;
  /** Current stage of an in-progress test edit (e.g. "Editing intro", "Rendering body 5/17"). */
  test_edit_stage: string | null;
}

/**
 * A YouTube channel's configuration. Replaces the per-list env vars: the Trello
 * board + the single SOURCE list the watcher polls live here (one row per
 * channel) and are managed from the dashboard Settings page. Cards are not moved
 * between lists; status is tracked in the episodes table. `drive_folder_id` is
 * optional and falls back to the watcher's GOOGLE_DRIVE_PARENT_FOLDER_ID.
 */
export interface Channel {
  id: string;
  name: string;
  trello_board_id: string;
  /** List the watcher polls for new cards. */
  trello_source_list_id: string;
  /** List a card is moved to when its episode finishes (with a Drive comment). */
  trello_resolve_list_id: string;
  drive_folder_id: string;
  enabled: boolean;
  /**
   * When true, the watcher builds the full episode video (flash/boom effect at
   * the card's EFFECT_PAUSING_TIMESTAMP + stitched intro) and uploads ONLY that
   * MP4. When false (default), it uploads the asset bundle as before.
   */
  video_mode: boolean;
  /**
   * When true, the watcher also builds the edited intro (via the compositor +
   * `intro_preset_id`) from the card's video attachment and uploads it to the
   * channel's Drive folder, in addition to the channel's normal output.
   */
  edit_intro_only: boolean;
  /** Saved intro-editor preset that drives the edited intro's look (or null). */
  intro_preset_id: string | null;
  created_at: string;
}

/** Fields accepted when creating/updating a channel (no server-managed keys). */
export type ChannelInput = Omit<Channel, 'id' | 'created_at'>;

/**
 * A saved intro-editor preset (the relative-style params from the editor's
 * deriveParams), reusable across clips and selectable per channel. `params` is the
 * editor's parameter object (numbers + flash/glitch/audio arrays), stored as jsonb.
 */
export interface IntroPreset {
  id: string;
  name: string;
  channel: string;
  params: Record<string, unknown>;
}

/**
 * Connection state of the single Google account used for Drive uploads, as
 * surfaced to the dashboard. The refresh token itself NEVER leaves the server.
 */
export interface DriveAuthStatus {
  connected: boolean;
  account_email: string | null;
}

/** A Google Drive folder, as surfaced to the dashboard folder dropdown. */
export interface DriveFolderOption {
  id: string;
  name: string;
}

/** A Trello board, as surfaced to the dashboard dropdowns. */
export interface TrelloBoardOption {
  id: string;
  name: string;
}

/** A Trello list, as surfaced to the dashboard dropdowns. */
export interface TrelloListOption {
  id: string;
  name: string;
}

/**
 * Result emitted by apps/watcher/src/pipeline.py on stdout.
 * Mirrored here so both the Node orchestrator and any TS tooling
 * share one contract.
 */
export type PipelineResult =
  | { success: true; zip_path: string; episode_name: string }
  | { success: false; error: string };
