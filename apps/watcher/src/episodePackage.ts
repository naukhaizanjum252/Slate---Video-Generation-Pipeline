/**
 * Parse a generated episode bundle (`episode_package.json` + the rendered images)
 * into a **body plan**: the ordered stills that make up the main video, each with an
 * on-screen window, plus the CTA windows where the subscribe overlay plays.
 *
 * Timing model (see apps/watcher/BODY_VIDEO_SPEC.md, validated against real data):
 *  - The body's first still is `reference_enhanced.png` (the enhanced reference image).
 *  - Then the 16 AI images (`images_2/NN_*.png`), in order.
 *  - Each `[IMAGE PROMPT N]` marker in `script_full_markdown` marks where image N enters;
 *    a still is on screen from its marker's narration offset until the next marker's.
 *  - Durations are proportional to the narration text between markers × the body
 *    voiceover duration. When an SRT is available, the offsets become exact (no rework).
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseSrt, findPhraseStart, findWordStarts } from './srt';

export interface BodyStill {
  /** 0 = enhanced reference image, 1..N = AI image N. */
  index: number;
  label: string; // 'enhanced_ref' | 'image_01' …
  imagePath: string;
  startSec: number; // within the body timeline
  durationSec: number;
}

export interface CtaWindow {
  kind: string; // e.g. 'after hook', 'between investigation and reckoning'
  startSec: number;
  durationSec: number;
}

export interface BodyPlan {
  subjectName: string;
  introLine: string; // intro VO (spoken during the edited intro)
  /** Freeze/zoom pause, in seconds into the intro clip — from the script's `@M:SS of intro vid`. */
  pauseAtSec: number;
  /** Where the body voiceover begins inside `audio/full.mp3` (≈ end of the intro line). */
  bodyStartSec: number;
  bodyDurationSec: number;
  stills: BodyStill[];
  ctas: CtaWindow[];
}

const NUL = String.fromCharCode(0);

/** Collapse a markdown chunk down to just its spoken narration length. */
function narrationLen(s: string): number {
  return s
    .replace(/\[[^\]]*\]/g, '') // bracketed directions / image prompts
    .replace(/^\s*#{1,6}.*$/gm, '') // ## Beat / ### headers
    .replace(/\s+/g, ' ')
    .trim().length;
}

const IS_IMAGE = (f: string) => /\.(png|jpe?g|webp)$/i.test(f);

/**
 * Every rendered AI image present, as {n, path}, sorted by number. Bundles vary across
 * studio versions, so search `images_2/` (canonical full set) then `images/`, matching a
 * leading number flexibly (`01_`, `1_`, `1.`…). images_2/ wins on conflicts.
 */
function listAiImages(bundleRoot: string): { n: number; path: string }[] {
  const byN = new Map<number, string>();
  for (const sub of ['images_2', 'images']) {
    const dir = path.join(bundleRoot, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!IS_IMAGE(f)) continue;
      const m = f.match(/^0*(\d+)/);
      if (!m) continue;
      const n = Number(m[1]);
      if (!byN.has(n)) byN.set(n, path.join(dir, f));
    }
  }
  return [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([n, p]) => ({ n, path: p }));
}

/**
 * Build the body plan from a bundle root and the full voiceover duration.
 * `fullVoDurationSec` is the length of `audio/full.mp3` (probe it before calling).
 */
export function parseBodyPlan(bundleRoot: string, fullVoDurationSec: number, srtPath?: string): BodyPlan {
  const pkgPath = path.join(bundleRoot, 'episode_package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  const md = String(pkg.script_full_markdown ?? '');
  if (!md) throw new Error(`episode_package.json has no script_full_markdown (${pkgPath})`);

  const subjectName = String(pkg.subject_name ?? '').trim();
  const introLine = String(pkg.intro_line ?? '').trim();
  // Pause for the intro freeze/zoom: the script's `[@0:04 of intro vid - …]` marker.
  const pauseMatch = String(pkg.intro_overlay ?? '').match(/@\s*(\d+):(\d+)\s*of\s*intro/i);
  const pauseAtSec = pauseMatch ? Number(pauseMatch[1]) * 60 + Number(pauseMatch[2]) : 0;

  // 1. Split the intro block (everything before "## Beat 1") from the body.
  const beat1 = md.search(/^##\s*Beat\s*1\b/m);
  const introMd = beat1 >= 0 ? md.slice(0, beat1) : '';
  const bodyMd = beat1 >= 0 ? md.slice(beat1) : md;

  // 2. Protect the markers we care about with NUL-delimited placeholders, then strip
  //    everything else down to narration so a placeholder's position == narration offset.
  let protectedMd = bodyMd
    .replace(/\[IMAGE PROMPT (\d+):[^\]]*\]/g, (_m, n) => `${NUL}I${n}${NUL}`)
    .replace(/^###\s*\[CTA\s*[—-]?\s*([^\]]*)\].*$/gm, (_m, kind) => `${NUL}C${String(kind).trim()}${NUL}`)
    // Beat headers bound a CTA's narration block (so a CTA window is just its paragraph,
    // not everything up to the next image). They don't split image stills.
    .replace(/^##\s*Beat[^\n]*$/gm, `${NUL}B${NUL}`);

  // Remove remaining bracket directions + headers, then collapse — placeholders survive.
  protectedMd = protectedMd
    .replace(/\[[^\]]*\]/g, '')
    .replace(/^\s*#{1,6}.*$/gm, '');

  // 3. Walk the segments, accumulating narration length; record each marker's offset.
  const tokens = protectedMd.split(new RegExp(`${NUL}(I\\d+|C[^${NUL}]*|B)${NUL}`));
  type Marker = { type: 'img' | 'cta' | 'beat'; n?: number; kind?: string; offset: number };
  const markers: Marker[] = [];
  let cum = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (i % 2 === 0) {
      cum += narrationLen(tokens[i]); // a narration segment
    } else {
      const tok = tokens[i];
      if (tok.startsWith('I')) markers.push({ type: 'img', n: Number(tok.slice(1)), offset: cum });
      else if (tok === 'B') markers.push({ type: 'beat', offset: cum });
      else markers.push({ type: 'cta', kind: tok.slice(1), offset: cum });
    }
  }
  const totalBodyChars = cum || 1;

  // 4. Where the body voiceover begins. Prefer the SRT: the spoken VO can differ in wording
  //    from the script's intro line, but the body OPENER (Beat 1) matches — so find that
  //    phrase in the SRT and split there (lands on a clean sentence). Fall back to a
  //    text-length proportional estimate when there's no SRT / no match.
  const introChars = narrationLen(introMd);
  const proportionalStart = fullVoDurationSec - fullVoDurationSec * (totalBodyChars / (introChars + totalBodyChars));
  const cues = srtPath && fs.existsSync(srtPath) ? parseSrt(srtPath) : [];
  const bodyOpening = bodyMd.replace(/\[[^\]]*\]/g, '').replace(/^\s*#{1,6}.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const srtStart = cues.length ? findPhraseStart(cues, bodyOpening) : null;
  const bodyStartSec = srtStart ?? proportionalStart;
  const bodyDurationSec = Math.max(1, fullVoDurationSec - bodyStartSec);
  const toSec = (chars: number) => (chars / totalBodyChars) * bodyDurationSec;

  // 5. Stills = the enhanced reference image + every rendered AI image, in order.
  //    Timing comes from the script's image markers when they line up with the rendered
  //    images; otherwise (some studio bundles don't embed inline markers) we fall back to
  //    an even split across the body. Either way the still LIST is driven by actual files,
  //    so a marker-less bundle still yields N+1 stills (not one giant hold).
  const imgMarkers = markers.filter((m) => m.type === 'img').sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const images = listAiImages(bundleRoot);
  const enhancedRef = path.join(bundleRoot, 'reference_enhanced.png');
  const stills: BodyStill[] = [];

  if (imgMarkers.length > 0 && imgMarkers.length === images.length) {
    // Marker-based timing: enhanced ref [0 → img1]; image k spans [imgk → imgk+1].
    const boundaries = [0, ...imgMarkers.map((m) => m.offset), totalBodyChars];
    for (let k = 0; k < boundaries.length - 1; k++) {
      const isRef = k === 0;
      stills.push({
        index: k,
        label: isRef ? 'enhanced_ref' : `image_${String(images[k - 1].n).padStart(2, '0')}`,
        imagePath: isRef ? enhancedRef : images[k - 1].path,
        startSec: toSec(boundaries[k]),
        durationSec: toSec(boundaries[k + 1]) - toSec(boundaries[k]),
      });
    }
  } else {
    // Even split across the enhanced ref + every image (approximate until the SRT lands).
    const count = images.length + 1;
    const each = bodyDurationSec / count;
    stills.push({ index: 0, label: 'enhanced_ref', imagePath: enhancedRef, startSec: 0, durationSec: each });
    images.forEach((img, i) =>
      stills.push({
        index: i + 1,
        label: `image_${String(img.n).padStart(2, '0')}`,
        imagePath: img.path,
        startSec: each * (i + 1),
        durationSec: each,
      }),
    );
  }

  // 6. CTA windows (body-relative). Primary: the actual spoken "subscribe" moment(s) in the
  //    SRT — that's where the subscribe bar should pop. Fallback: the script's [CTA] markers.
  const ctas: CtaWindow[] = [];
  const subStarts = cues.length ? findWordStarts(cues, 'subscrib', bodyStartSec) : [];
  if (subStarts.length) {
    for (const s of subStarts) ctas.push({ kind: 'subscribe', startSec: Math.max(0, s - bodyStartSec), durationSec: 8 });
  } else {
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      if (m.type !== 'cta') continue;
      const next = markers[i + 1];
      const endC = next ? next.offset : totalBodyChars;
      ctas.push({ kind: m.kind ?? 'cta', startSec: toSec(m.offset), durationSec: toSec(endC) - toSec(m.offset) });
    }
  }

  return { subjectName, introLine, pauseAtSec, bodyStartSec, bodyDurationSec, stills, ctas };
}

/**
 * Truncate a still list to the first `maxSec` seconds **at real durations** (only the
 * last included still is clipped to land exactly on maxSec). The result looks identical
 * to the start of the full body — used for the N-second "test edit". Returns the stills
 * with recomputed startSec; the total = sum of their durations (≤ maxSec).
 */
export function truncateStills(stills: BodyStill[], maxSec: number): BodyStill[] {
  const out: BodyStill[] = [];
  let acc = 0;
  for (const s of stills) {
    if (acc >= maxSec - 0.05) break;
    const dur = Math.min(s.durationSec, maxSec - acc);
    out.push({ ...s, startSec: acc, durationSec: dur });
    acc += dur;
  }
  return out;
}
