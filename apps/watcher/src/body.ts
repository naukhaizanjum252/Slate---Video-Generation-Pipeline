/**
 * Build the main video **body** from a generated bundle's stills (the enhanced
 * reference image + the AI images), driven by a parsed body plan.
 *
 * Look (see apps/watcher/BODY_VIDEO_SPEC.md, matched to the reference clip):
 *  - each still fills 16:9 via a blurred/darkened copy of itself behind a sharp,
 *    centered foreground, with a slow **oscillating** Ken-Burns zoom (supersampled);
 *  - stills are joined by a **dip to black** (fade out → fade in);
 *  - a looped **film-grain** overlay is screen-blended over the whole body;
 *  - the body voiceover (a slice of `audio/full.mp3`) is the audio bed;
 *  - captions (libass) are burned when an SRT is supplied.
 *
 * The CTA subscribe overlay is wired as a hook but disabled until the asset lands.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FFMPEG, run } from './video';
import { createLogger } from './logger';
import type { BodyStill, CtaWindow } from './episodePackage';

const log = createLogger('body');

// Matches the intro's caption look (thin outline, centered, bottom).
const CAPTION_STYLE =
  "FontName=Arial,Fontsize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.4,Shadow=0,Alignment=2,MarginV=60";

export function resolveGrainOverlay(): string {
  const override = process.env.FILM_GRAIN_PATH?.trim();
  const candidates = [
    ...(override ? [override] : []),
    path.resolve(__dirname, 'assets/overlays/film_grain.mp4'),
    path.resolve(__dirname, '../assets/overlays/film_grain.mp4'),
    path.resolve(__dirname, '../src/assets/overlays/film_grain.mp4'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

export function resolveCtaOverlay(): string {
  const override = process.env.CTA_OVERLAY_PATH?.trim();
  const candidates = [
    ...(override ? [override] : []),
    path.resolve(__dirname, 'assets/overlays/cta_overlay.mp4'),
    path.resolve(__dirname, '../assets/overlays/cta_overlay.mp4'),
    path.resolve(__dirname, '../src/assets/overlays/cta_overlay.mp4'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

export interface BuildBodyOpts {
  stills: BodyStill[];
  voiceoverPath: string; // audio/full.mp3
  bodyStartSec: number; // where the body VO begins inside the full voiceover
  bodyDurationSec: number; // total body length (= sum of still durations)
  outPath: string;
  workDir: string;
  grainPath?: string; // defaults to the bundled film_grain.mp4
  srtPath?: string; // full-voiceover SRT (shifted to the body timeline if given)
  ctas?: CtaWindow[]; // for the CTA overlay (not yet rendered)
  ctaOverlayPath?: string; // subscribe overlay video (pending asset)
  fps?: number; // default 30
  width?: number; // default 1920
  height?: number; // default 1080
  transitionSec?: number; // dip-to-black total, default 0.8
  onProgress?: (stage: string) => void; // coarse progress ("Rendering body 5/17", "Assembling body")
  concurrency?: number; // parallel still renders (default min(cpus-1, 4))
  isCancelled?: () => boolean | Promise<boolean>; // polled to abort the render (Stop button)
}

interface Req extends Required<Omit<BuildBodyOpts, 'srtPath' | 'ctas' | 'ctaOverlayPath' | 'grainPath' | 'onProgress' | 'concurrency' | 'isCancelled'>> {
  grainPath: string;
}

class CancelledError extends Error {
  constructor() {
    super('Render cancelled');
    this.name = 'CancelledError';
  }
}

/** Build the static composite (blurred 16:9 fill + centered sharp image) as a single PNG.
 *
 * The blur is by far the most expensive filter and it's static, so we render it ONCE per
 * image. The zoom + fades are applied later, inline in the single assembly pass — so the
 * body is encoded only once (no throwaway per-still MP4s). */
async function renderComposite(still: BodyStill, o: Req, outPng: string, signal?: AbortSignal): Promise<void> {
  const { width: W, height: H } = o;
  const fgW = Math.round((W * 0.86) / 2) * 2; // foreground width, leaving margin for the blurred fill
  const fc = [
    `[0:v]split=2[a][b]`,
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=45,eq=brightness=-0.40:saturation=0.65[bg]`,
    `[b]scale=${fgW}:-1:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[c]`,
  ].join(';');
  await run(FFMPEG, ['-y', '-i', still.imagePath, '-filter_complex', fc, '-map', '[c]', '-frames:v', '1', outPng], 10 * 60_000, signal);
}

/** The per-image constant-zoom + dip-fade filter chain, applied inline in the assembly pass.
 * `scale` interpolates sub-pixels → smooth even on long slow holds (zoompan steps → "shaky").
 * Direction alternates per still (gentle in / out). */
function zoomChain(still: BodyStill, o: Req, inLabel: string, outLabel: string): string {
  const { width: W, fps, transitionSec } = o;
  const dur = Math.max(0.5, still.durationSec);
  const N = Math.max(1, Math.round(dur * fps));
  const fade = Math.max(0.15, Math.min(transitionSec / 2, dur / 3));
  const ZOOM = 0.06;
  const zoomIn = still.index % 2 === 0;
  const za = zoomIn ? 1.0 : 1 + ZOOM;
  const zb = zoomIn ? 1 + ZOOM : 1.0;
  const dz = (zb - za).toFixed(5);
  const zExpr = `(${za}+(${dz})*n/${Math.max(1, N - 1)})`;
  return (
    `${inLabel}scale=w='ceil((${W}*${zExpr})/2)*2':h=-2:eval=frame:flags=bicubic,crop=${W}:${o.height},` +
    `fade=t=in:st=0:d=${fade.toFixed(2)},fade=t=out:st=${(dur - fade).toFixed(2)}:d=${fade.toFixed(2)},setsar=1,format=yuv420p${outLabel}`
  );
}

/** Shift an SRT by `deltaSec` (clamping/ dropping cues that fall before 0). */
function shiftSrtBy(srcSrt: string, deltaSec: number, outPath: string): void {
  const txt = fs.readFileSync(srcSrt, 'utf8');
  const toMs = (h: string, m: string, s: string, ms: string) => ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;
  const fmt = (ms: number) => {
    ms = Math.max(0, ms);
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
  };
  const out = txt.replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g,
    (_m, h1, m1, s1, x1, h2, m2, s2, x2) => {
      const a = toMs(h1, m1, s1, x1) + deltaSec * 1000;
      const b = toMs(h2, m2, s2, x2) + deltaSec * 1000;
      return `${fmt(a)} --> ${fmt(b)}`;
    });
  fs.writeFileSync(outPath, out);
}

function escapeForSubtitles(p: string): string {
  // ffmpeg filter arg: escape \  :  '  for the subtitles=filename= value
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export async function buildBody(opts: BuildBodyOpts): Promise<string> {
  const o: Req = {
    stills: opts.stills,
    voiceoverPath: opts.voiceoverPath,
    bodyStartSec: opts.bodyStartSec,
    bodyDurationSec: opts.bodyDurationSec,
    outPath: opts.outPath,
    workDir: opts.workDir,
    grainPath: opts.grainPath ?? resolveGrainOverlay(),
    fps: opts.fps ?? 30,
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    transitionSec: opts.transitionSec ?? 0.8,
  };
  fs.mkdirSync(o.workDir, { recursive: true });
  if (!o.stills.length) throw new Error('buildBody: no stills');

  // Cancellation: poll the Stop flag and abort the active ffmpeg child(ren) when set.
  const ac = new AbortController();
  let poller: ReturnType<typeof setInterval> | undefined;
  if (opts.isCancelled) {
    poller = setInterval(() => {
      Promise.resolve(opts.isCancelled!())
        .then((c) => c && ac.abort())
        .catch(() => {});
    }, 2000);
  }
  const checkCancel = async () => {
    if (ac.signal.aborted || (opts.isCancelled && (await opts.isCancelled()))) throw new CancelledError();
  };

  try {
    // 1. Build each still's blurred composite as a PNG (blur runs once per image; cheap,
    //    pooled across cores). The zoom is applied later, inline, so there are no per-still
    //    video encodes — the body is encoded exactly once.
    const comps = o.stills.map((_, i) => path.join(o.workDir, `comp_${String(i).padStart(2, '0')}.png`));
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? Math.max(1, (os.cpus()?.length ?? 2) - 1), 4));
    let done = 0;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= o.stills.length) return;
        await checkCancel();
        log.info(`[body] composite ${o.stills[i].label} (${o.stills[i].durationSec.toFixed(1)}s)`);
        await renderComposite(o.stills[i], o, comps[i], ac.signal);
        opts.onProgress?.(`Rendering body ${++done}/${o.stills.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, o.stills.length) }, () => worker()));
    await checkCancel();
    opts.onProgress?.('Assembling body');

    // 2. SINGLE pass: zoom each composite inline → concat → screen-blend grain → burn
    //    captions → overlay CTA → mux the body slice of the voiceover. One encode total.
    const { width: W, height: H, fps } = o;
    const K = o.stills.length;
    const inputs: string[] = [];
    o.stills.forEach((s, i) => {
      const dur = Math.max(0.5, s.durationSec).toFixed(3);
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', dur, '-i', comps[i]);
    });
    inputs.push('-stream_loop', '-1', '-i', o.grainPath);
    inputs.push('-ss', o.bodyStartSec.toFixed(3), '-i', o.voiceoverPath);
    const grainIdx = K;
    const audioIdx = K + 1;

    // CTA overlay: only windows within the rendered length; each gets its own time-shifted input.
    const ctaPath = opts.ctaOverlayPath ?? resolveCtaOverlay();
    const ctas = opts.ctas && fs.existsSync(ctaPath) ? opts.ctas.filter((c) => c.startSec < o.bodyDurationSec - 0.5) : [];
    const ctaBaseIdx = audioIdx + 1;
    ctas.forEach((c) => inputs.push('-itsoffset', c.startSec.toFixed(3), '-i', ctaPath));

    const fc: string[] = [];
    o.stills.forEach((s, i) => fc.push(zoomChain(s, o, `[${i}:v]`, `[z${i}]`)));
    fc.push(`${o.stills.map((_, i) => `[z${i}]`).join('')}concat=n=${K}:v=1:a=0[cat]`);
    fc.push(`[${grainIdx}:v]scale=${W}:${H},setsar=1,format=gbrp[g]`);
    fc.push(`[cat]format=gbrp[base]`);
    fc.push(`[base][g]blend=all_mode=screen:shortest=1[bl]`);
    fc.push(`[bl]format=yuv420p[v0]`);
    let cur = '[v0]';

    if (opts.srtPath && fs.existsSync(opts.srtPath)) {
      const cc = path.join(o.workDir, 'body_cc.srt');
      shiftSrtBy(opts.srtPath, -o.bodyStartSec, cc);
      fc.push(`${cur}subtitles=filename=${escapeForSubtitles(cc)}:force_style='${CAPTION_STYLE}'[vcc]`);
      cur = '[vcc]';
    }

    const ctaW = Math.round((W * 0.62) / 2) * 2;
    ctas.forEach((c, i) => {
      const show = Math.min(8, c.durationSec).toFixed(2);
      fc.push(`[${ctaBaseIdx + i}:v]chromakey=0x00FF1C:0.30:0.12,scale=${ctaW}:-1,setsar=1[cta${i}]`);
      fc.push(`${cur}[cta${i}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${c.startSec.toFixed(2)},${(c.startSec + Number(show)).toFixed(2)})'[ov${i}]`);
      cur = `[ov${i}]`;
    });

    fc.push(`${cur}format=yuv420p[vout]`);

    const args = [
      '-y', ...inputs,
      '-filter_complex', fc.join(';'),
      '-map', '[vout]', '-map', `${audioIdx}:a`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-t', o.bodyDurationSec.toFixed(3),
      o.outPath,
    ];
    log.info(`[body] assembling ${K} stills + grain + audio (single pass) -> ${path.basename(o.outPath)}`);
    await run(FFMPEG, args, 90 * 60_000, ac.signal);
    comps.forEach((c) => {
      try {
        fs.unlinkSync(c);
      } catch {
        /* ignore */
      }
    });
    return o.outPath;
  } finally {
    if (poller) clearInterval(poller);
  }
}
