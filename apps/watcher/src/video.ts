/**
 * ffmpeg-based post-processing for video-mode episodes:
 *   1. applyFreezeFlashBoom — at a timestamp, freeze the frame briefly, flash
 *      white, and play the boom SFX (an impact beat).
 *   2. prependIntro — normalize the card's intro clip to the main video's spec
 *      and stitch it onto the FRONT.
 *
 * Requires ffmpeg + ffprobe on the host (the studio droplet already has them for
 * its own video build). Override the binaries with FFMPEG_BIN / FFPROBE_BIN.
 *
 * NOTE: the exact look (freeze length, flash intensity) is first-cut and meant
 * to be tuned against a real clip — the structure is what matters here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as tmp from 'tmp';
import { createLogger } from './logger';

const log = createLogger('video');

export const FFMPEG = process.env.FFMPEG_BIN?.trim() || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_BIN?.trim() || 'ffprobe';

// Effect tuning knobs.
const FREEZE_SEC = 0.5; // how long the frozen frame holds
const FLASH_SEC = 0.12; // white-flash duration at the start of the freeze

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  hasAudio: boolean;
}

/** Spawn ffmpeg/ffprobe and resolve stdout, or reject with a trimmed stderr. */
export function run(bin: string, args: string[], timeoutMs = 20 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${Math.round(timeoutMs / 60000)}m`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) =>
      reject(new Error(`Failed to run ${bin}: ${e.message} (is it installed / on PATH?)`)),
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited ${code}: ${err.trim().slice(-1400)}`));
    });
  });
}

/** Probe a video's geometry, frame rate, duration, and audio presence. */
export async function probeVideo(input: string): Promise<VideoInfo> {
  const out = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate',
    '-show_entries', 'format=duration',
    '-of', 'json',
    input,
  ]);
  const data = JSON.parse(out) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video') ?? {};
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  const [n, d] = String(v.r_frame_rate ?? '30/1').split('/').map(Number);
  const fps = d ? n / d : 30;
  return {
    width: Number(v.width) || 1920,
    height: Number(v.height) || 1080,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    duration: Number(data.format?.duration) || 0,
    hasAudio,
  };
}

/** Find the largest .mp4 under a directory (the built episode video). */
export function findEpisodeVideo(rootDir: string): string | null {
  const mp4s: { path: string; size: number }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.(mp4|mov|webm|mkv)$/i.test(e.name)) {
        mp4s.push({ path: full, size: fs.statSync(full).size });
      }
    }
  };
  try {
    walk(rootDir);
  } catch {
    return null;
  }
  if (mp4s.length === 0) return null;
  mp4s.sort((a, b) => b.size - a.size);
  return mp4s[0].path;
}

/** Resolve the bundled boom SFX (override with BOOM_SFX_PATH). */
export function resolveBoomSfx(): string {
  const override = process.env.BOOM_SFX_PATH?.trim();
  const candidates = [
    ...(override ? [override] : []),
    path.resolve(__dirname, 'assets/sfx/boom.wav'), // ts-node / copied alongside dist
    path.resolve(__dirname, '../assets/sfx/boom.wav'), // compiled dist/ -> ../assets
    path.resolve(__dirname, '../src/assets/sfx/boom.wav'), // compiled dist/ -> ../src/assets
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

/**
 * Freeze the frame at `tSec` for FREEZE_SEC, flash white at the cut, and play the
 * boom SFX over the freeze. Done in passes via a temp dir: split → grab frame →
 * build freeze clip → concat. Returns the new video path. If the timestamp is
 * out of range, returns the input unchanged.
 */
export async function applyFreezeFlashBoom(
  input: string,
  tSec: number,
  boomPath: string,
  outPath: string,
): Promise<string> {
  const info = await probeVideo(input);
  if (tSec <= 0 || (info.duration && tSec >= info.duration)) {
    log.warn(`Effect timestamp ${tSec}s out of range (duration ${info.duration}s) — skipping effect`);
    return input;
  }
  if (!fs.existsSync(boomPath)) {
    throw new Error(
      `Boom SFX not found at ${boomPath}. Add it (apps/watcher/assets/sfx/boom.wav) or set BOOM_SFX_PATH.`,
    );
  }

  const { width: W, height: H, fps } = info;
  const work = tmp.dirSync({ prefix: 'slate-fx-', unsafeCleanup: true });
  try {
    const part1 = path.join(work.name, 'part1.mp4');
    const part2 = path.join(work.name, 'part2.mp4');
    const frame = path.join(work.name, 'frame.png');
    const freeze = path.join(work.name, 'freeze.mp4');
    const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2'];

    // Segment before/after the effect point (re-encoded for clean concat).
    await run(FFMPEG, ['-y', '-i', input, '-t', String(tSec), ...enc, part1]);
    await run(FFMPEG, ['-y', '-ss', String(tSec), '-i', input, ...enc, part2]);

    // Grab the frame at the cut, build a FREEZE_SEC clip with a white flash that
    // fades out, using the boom as the freeze's audio.
    await run(FFMPEG, ['-y', '-ss', String(tSec), '-i', input, '-frames:v', '1', frame]);
    await run(FFMPEG, [
      '-y',
      '-loop', '1', '-t', String(FREEZE_SEC), '-i', frame,
      '-i', boomPath,
      '-filter_complex',
      `[0:v]scale=${W}:${H},fps=${fps},format=yuv420p,fade=t=in:st=0:d=${FLASH_SEC}:color=white[v]`,
      '-map', '[v]', '-map', '1:a',
      '-t', String(FREEZE_SEC),
      ...enc,
      freeze,
    ]);

    // Concat part1 + freeze + part2.
    const listFile = path.join(work.name, 'list.txt');
    fs.writeFileSync(
      listFile,
      [part1, freeze, part2].map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
    );
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, ...enc, outPath]);
    log.info(`Applied freeze+flash+boom at ${tSec}s -> ${outPath}`);
    return outPath;
  } finally {
    try {
      work.removeCallback();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Stitch `intro` onto the FRONT of `main`, writing `outPath`.
 *
 * Re-encodes ONLY the short intro to the body's exact geometry/fps/codec, then joins by
 * STREAM COPY via the concat demuxer — so the long body is never re-encoded (prepending a
 * ~30 s intro shouldn't cost a full re-encode of a 30-min episode). Because the normalized
 * intro and the body share identical encode settings, the copy-concat is seamless.
 */
export async function prependIntro(intro: string, main: string, outPath: string): Promise<string> {
  const info = await probeVideo(main);
  const introInfo = await probeVideo(intro);
  const { width: W, height: H, fps } = info;
  const dir = path.dirname(outPath);

  // 1. Normalize the intro to the body's spec (cheap — it's only seconds long).
  const introNorm = path.join(dir, 'intro_norm.mp4');
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
  const nargs = ['-y', '-i', intro];
  let aMap = '0:a:0';
  if (!introInfo.hasAudio) {
    nargs.push('-f', 'lavfi', '-t', String(Math.max(introInfo.duration, 0.1)), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    aMap = '1:a:0';
  }
  nargs.push(
    '-vf', vf,
    '-map', '0:v:0', '-map', aMap,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    introNorm,
  );
  await run(FFMPEG, nargs, 20 * 60_000);

  // 2. Concat by stream copy — the body passes through untouched.
  const list = path.join(dir, 'concat_list.txt');
  const esc = (p: string) => p.replace(/'/g, "'\\''");
  fs.writeFileSync(list, `file '${esc(introNorm)}'\nfile '${esc(main)}'\n`);
  await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outPath], 20 * 60_000);

  try { fs.unlinkSync(introNorm); } catch { /* ignore */ }
  try { fs.unlinkSync(list); } catch { /* ignore */ }
  log.info(`Stitched intro (copy-concat) onto front -> ${outPath}`);
  return outPath;
}
