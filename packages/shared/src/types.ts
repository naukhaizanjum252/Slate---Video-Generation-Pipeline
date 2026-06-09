export type EpisodeStatus = 'processing' | 'done' | 'failed' | 'cancelled';

/** One concurrent sub-task of the current phase (e.g. Images, Voiceover). */
export interface ProgressStep {
  label: string;
  text: string;
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
  /** Set by the dashboard's Stop button; the watcher acts on it and cancels. */
  cancel_requested: boolean;
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
  trello_source_list_id: string;
  drive_folder_id: string;
  enabled: boolean;
  created_at: string;
}

/** Fields accepted when creating/updating a channel (no server-managed keys). */
export type ChannelInput = Omit<Channel, 'id' | 'created_at'>;

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
