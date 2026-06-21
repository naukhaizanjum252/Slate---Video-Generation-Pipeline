/**
 * Parse the optional effect directive out of a Trello card description.
 *
 * Convention (video-mode channels): a line like
 *     EFFECT_PAUSING_TIMESTAMP: 01:23
 * marks where to apply the freeze + white-flash + boom effect on the generated
 * episode video. The timestamp accepts HH:MM:SS, MM:SS, or bare seconds, with an
 * optional ':' or '=' after the key. Exactly one per card (first match wins).
 */
const EFFECT_KEY = 'EFFECT_PAUSING_TIMESTAMP';

export interface ParsedEffect {
  /** Effect timestamp in seconds, or null if the card didn't specify one. */
  effectTimestampSec: number | null;
  /** The brief with the directive line removed — what we send to the studio. */
  cleanedBrief: string;
}

/**
 * Pull the subject name out of a card description (video mode). Convention:
 *     INTRO_SUBJECT_NAME: Sal Cangelosi
 * Takes the rest of that line. Returns null if absent.
 */
export function parseSubjectName(brief: string): string | null {
  if (!brief) return null;
  // Trello escapes underscores in descriptions (INTRO\_SUBJECT\_NAME) to avoid
  // markdown italics — undo that before matching.
  const text = brief.replace(/\\_/g, '_');
  const m = text.match(/INTRO_SUBJECT_NAME\s*[:=]?\s*(.+)/i);
  if (!m) return null;
  const name = m[1].split(/\r?\n/)[0].trim();
  return name || null;
}

export function parseEffect(brief: string): ParsedEffect {
  // Trello escapes underscores (EFFECT\_PAUSING\_TIMESTAMP) — undo before matching.
  const text = (brief ?? '').replace(/\\_/g, '_');
  if (!text) return { effectTimestampSec: null, cleanedBrief: text };
  // Value is digit groups separated by ':' or '.' (e.g. 90, 1:30, or 01.30).
  const re = new RegExp(`${EFFECT_KEY}\\s*[:=]?\\s*([0-9]+(?:[:.][0-9]+){0,2})`, 'i');
  const m = text.match(re);
  if (!m) return { effectTimestampSec: null, cleanedBrief: text };
  const effectTimestampSec = timestampToSeconds(m[1]);
  // Strip the directive (and collapse the blank space it leaves) before the
  // brief is sent on for script generation.
  const cleanedBrief = text.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim();
  return { effectTimestampSec, cleanedBrief };
}

/**
 * Convert a timestamp to seconds. Accepts ':' OR '.' as the field separator, so
 * the project convention `MM.SS` works (e.g. "00.03" = 3s, "01.30" = 90s), as do
 * "MM:SS", "HH:MM:SS", and bare seconds ("90"). Returns null if malformed.
 *
 * Note: because '.' is treated as a field separator, decimal seconds like "3.5"
 * mean 3 minutes 5 seconds, not 3.5s — timestamps here are whole seconds.
 */
export function timestampToSeconds(ts: string): number | null {
  const parts = ts.trim().split(/[:.]/).map((p) => p.trim());
  if (parts.length === 0 || parts.length > 3) return null;
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  const nums = parts.map(Number);
  let sec: number;
  if (nums.length === 1) sec = nums[0];
  else if (nums.length === 2) sec = nums[0] * 60 + nums[1];
  else sec = nums[0] * 3600 + nums[1] * 60 + nums[2];
  return Number.isFinite(sec) && sec >= 0 ? sec : null;
}
