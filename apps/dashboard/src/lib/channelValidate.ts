import type { ChannelInput } from '@slate/shared';

type ValidationResult = { value: ChannelInput } | { error: string };

const REQUIRED: (keyof ChannelInput)[] = [
  'name',
  'trello_board_id',
  'trello_source_list_id',
  'trello_resolve_list_id',
  'drive_folder_id',
];

/**
 * Validate + normalize a channel payload from the dashboard. Returns a clean
 * ChannelInput or an error string. Keeps route handlers thin.
 */
export function validateChannel(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) return { error: 'Body must be an object' };
  const b = body as Record<string, unknown>;

  for (const key of REQUIRED) {
    const v = b[key];
    if (typeof v !== 'string' || v.trim() === '') {
      return { error: `Missing or empty field: ${key}` };
    }
  }

  // Source and resolve lists must differ, or a card would move to itself.
  if (
    (b.trello_source_list_id as string).trim() === (b.trello_resolve_list_id as string).trim()
  ) {
    return { error: 'Source and resolve lists must be different' };
  }

  const value: ChannelInput = {
    name: (b.name as string).trim(),
    trello_board_id: (b.trello_board_id as string).trim(),
    trello_source_list_id: (b.trello_source_list_id as string).trim(),
    trello_resolve_list_id: (b.trello_resolve_list_id as string).trim(),
    drive_folder_id: (b.drive_folder_id as string).trim(),
    enabled: b.enabled === undefined ? true : Boolean(b.enabled),
    video_mode: Boolean(b.video_mode),
  };
  return { value };
}
