/**
 * Minimal SRT parsing + text alignment. Used to drive timing off the ACTUAL spoken
 * voiceover (the SRT), which can differ in wording from the generated script — so we
 * match on distinctive phrases / words rather than exact text.
 */
import * as fs from 'fs';

export interface SrtCue {
  startSec: number;
  endSec: number;
  text: string;
}

const TS = /(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function toSec(h: string, m: string, s: string, ms: string): number {
  return +h * 3600 + +m * 60 + +s + +ms.padEnd(3, '0') / 1000;
}

/** Normalize for fuzzy matching: lowercase, strip punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseSrt(srtPath: string): SrtCue[] {
  const txt = fs.readFileSync(srtPath, 'utf8').replace(/\r/g, '');
  const cues: SrtCue[] = [];
  for (const block of txt.split(/\n\n+/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const tsLine = lines.find((l) => TS.test(l));
    if (!tsLine) continue;
    const m = tsLine.match(TS)!;
    const text = lines.slice(lines.indexOf(tsLine) + 1).join(' ').trim();
    if (!text) continue;
    cues.push({ startSec: toSec(m[1], m[2], m[3], m[4]), endSec: toSec(m[5], m[6], m[7], m[8]), text });
  }
  return cues;
}

/**
 * Find where `phrase` is first spoken and return that cue's START time. Matches the
 * first few words (tolerant of differing tails / punctuation). Returns null if not found.
 */
export function findPhraseStart(cues: SrtCue[], phrase: string): number | null {
  const words = normalize(phrase).split(' ').filter(Boolean);
  for (const take of [7, 5, 4]) {
    if (words.length < take) continue;
    const needle = words.slice(0, take).join(' ');
    const hit = cues.find((c) => normalize(c.text).includes(needle));
    if (hit) return hit.startSec;
  }
  return null;
}

/** Start times of every cue containing `word` (normalized substring), at/after `afterSec`. */
export function findWordStarts(cues: SrtCue[], word: string, afterSec = 0): number[] {
  const w = normalize(word);
  return cues.filter((c) => c.startSec >= afterSec - 0.001 && normalize(c.text).includes(w)).map((c) => c.startSec);
}

function fmtTs(sec: number): string {
  let t = Math.round(Math.max(0, sec) * 1000); // integer ms — fractional values break SRT parsing
  const h = Math.floor(t / 3600000); t -= h * 3600000;
  const m = Math.floor(t / 60000); t -= m * 60000;
  const s = Math.floor(t / 1000); t -= s * 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(t, 3)}`;
}

/** Write cues back out as a valid SRT (optionally shifted by `offsetSec`, dropping <0 cues). */
export function writeSrt(cues: SrtCue[], outPath: string, offsetSec = 0): void {
  const shifted = cues
    .map((c) => ({ startSec: c.startSec + offsetSec, endSec: c.endSec + offsetSec, text: c.text }))
    .filter((c) => c.endSec > 0)
    .map((c) => ({ ...c, startSec: Math.max(0, c.startSec) }));
  const out = shifted.map((c, i) => `${i + 1}\n${fmtTs(c.startSec)} --> ${fmtTs(c.endSec)}\n${c.text}`).join('\n\n') + '\n';
  fs.writeFileSync(outPath, out);
}
