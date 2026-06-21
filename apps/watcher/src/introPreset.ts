/**
 * Build an absolute-timeline IntroSpec from a saved editor preset (relative-style
 * params) + the actual card inputs. This is the server-side port of the editor's
 * `applyParams`, so the watcher renders the same look the editor previews. Empty
 * params → sensible defaults (mirrors the editor's defaultSpec).
 */
import type { IntroSpec, IntroAudioClip } from './intro';

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export interface IntroInputsFromCard {
  clipDuration: number; // intro clip length (s)
  voDuration: number; // voiceover length (s), 0 if none
  subjectName: string;
  pauseAtSec: number; // EFFECT_PAUSING_TIMESTAMP (0 = derive a default)
}

export function specFromPreset(
  params: Record<string, unknown> | null | undefined,
  inputs: IntroInputsFromCard,
): IntroSpec {
  const p = (params ?? {}) as Record<string, unknown>;
  const clip = Math.max(0.5, inputs.clipDuration || 0);
  const V = Math.max(0, inputs.voDuration || 0);
  const T = clampN(inputs.pauseAtSec > 0 ? inputs.pauseAtSec : clampN(clip * 0.2, 0.5, 4), 0.2, Math.max(0.3, clip - 0.3));
  const name = inputs.subjectName || '';

  const entrance = num(p.entranceSec, 1.0);
  const exit = num(p.exitSec, 0.9);
  const endTail = num(p.endTailSec, 3.0);
  const black = num(p.blackSec, 2.0);
  const F = entrance + V + exit;
  const s2 = T + F + Math.max(0.1, clip - T);
  const totalD = s2 + black;
  const clickVol = num(p.clickVolume, 1);

  // Reconstruct the layout from the PAUSE so it's fully pause-relative: pause-anchored
  // beats (clicks, voiceover) move with T; end-anchored beats (grain/boom) follow the
  // freeze/clip end (s2); music spans the whole thing. (Saved absolute audio positions
  // are intentionally ignored — only the structural params + volumes drive timing.)
  const audio: IntroAudioClip[] = [
    { kind: 'click', start: T, volume: clickVol }, // at the pause
    { kind: 'click', start: T + entrance + V, volume: clickVol }, // at the unfreeze
    { kind: 'grain', start: Math.max(0, s2 - endTail), duration: endTail, fadeInSec: endTail, volume: num(p.grainVolume, 2) },
    { kind: 'boom', start: s2, volume: num(p.boomVolume, 1) },
    { kind: 'music', start: 0, duration: totalD, volume: num(p.musicVolume, 0.5) },
  ];
  if (V > 0) audio.push({ kind: 'voiceover', start: T + entrance, duration: V, volume: num(p.voVolume, 1) });

  const hi = T + F;
  const gOpac = num(p.glitchOpacity, 1);
  const pFlashes = p.flashes as Array<{ rel?: number }> | undefined;
  const pGlitches = p.glitches as Array<{ rel?: number; opacity?: number }> | undefined;
  const flashes =
    Array.isArray(pFlashes) && pFlashes.length
      ? pFlashes.map((f) => ({ atSec: clampN(T + (f.rel ?? 0), T, hi) }))
      : [{ atSec: T }];
  const glitches =
    Array.isArray(pGlitches) && pGlitches.length
      ? pGlitches.map((g) => ({ atSec: clampN(T + (g.rel ?? 0), T, hi), opacity: g.opacity != null ? g.opacity : gOpac }))
      : [{ atSec: clampN(T + entrance + V, T, hi), opacity: gOpac }];

  return {
    pauseAtSec: T,
    freezeDurationSec: F,
    blackSec: black,
    zoom: num(p.zoom, 1.2),
    flashSec: num(p.flashSec, 0.6),
    glitchAtSec: T + entrance + V,
    glitchDurationSec: exit,
    glitchOpacity: gOpac,
    textStartSec: T + entrance,
    subjectName: name,
    textCenterX: num(p.textCenterX, 0.5),
    textCenterY: num(p.textCenterY, 0.4),
    hasText: true,
    hasWatermark: true,
    flashes,
    glitches,
    audio,
  };
}
