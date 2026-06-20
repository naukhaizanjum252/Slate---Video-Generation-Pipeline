/**
 * Standalone tester for the video-mode ffmpeg steps — no studio / Trello /
 * Supabase / Drive involved. Runs the freeze+flash+boom effect and/or the intro
 * stitch on local files and writes an output you can open and eyeball.
 *
 * Needs ffmpeg + ffprobe on PATH (brew install ffmpeg).
 *
 * Examples:
 *   # effect only, at 3 seconds, using the bundled boom (or --boom path):
 *   pnpm --filter @slate/watcher test-video -- --in clip.mp4 --at 3
 *
 *   # effect at 00:05 with a specific boom, then prepend an intro:
 *   pnpm --filter @slate/watcher test-video -- \
 *     --in clip.mp4 --at 00:05 --boom boom.wav --intro intro.mp4 --out result.mp4
 *
 *   # just the intro stitch:
 *   pnpm --filter @slate/watcher test-video -- --in clip.mp4 --intro intro.mp4
 */
import * as path from 'path';
import * as fs from 'fs';
import * as tmp from 'tmp';
import { applyFreezeFlashBoom, prependIntro, resolveBoomSfx } from '../src/video';
import { timestampToSeconds } from '../src/effects';
import { createLogger } from '../src/logger';

const log = createLogger('test-video');

/** Read `--name value` from argv. */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const input = arg('in');
  if (!input || !fs.existsSync(input)) {
    log.error('Provide an existing input video: --in <file.mp4>');
    process.exit(1);
  }
  const at = arg('at'); // seconds or HH:MM:SS / MM:SS
  const introPath = arg('intro');
  const boom = arg('boom') ?? resolveBoomSfx();
  const out = path.resolve(arg('out') ?? 'slate-test-output.mp4');

  if (at === undefined && !introPath) {
    log.warn('Nothing to do — pass --at <time> for the effect and/or --intro <file> to stitch.');
    process.exit(1);
  }

  const work = tmp.dirSync({ prefix: 'slate-testvid-', unsafeCleanup: true });
  try {
    let current = path.resolve(input);

    if (at !== undefined) {
      const sec = timestampToSeconds(at);
      if (sec === null) {
        log.error(`Bad --at timestamp: "${at}" (use seconds, MM:SS, or HH:MM:SS)`);
        process.exit(1);
      }
      log.info(`Applying freeze + flash + boom at ${sec}s (boom: ${boom})`);
      const fx = path.join(work.name, 'fx.mp4');
      current = await applyFreezeFlashBoom(current, sec, boom, fx);
    }

    if (introPath) {
      if (!fs.existsSync(introPath)) {
        log.error(`Intro not found: ${introPath}`);
        process.exit(1);
      }
      log.info(`Stitching intro "${introPath}" onto the front`);
      const stitched = path.join(work.name, 'stitched.mp4');
      current = await prependIntro(path.resolve(introPath), current, stitched);
    }

    fs.copyFileSync(current, out);
    log.info(`✅ Done -> ${out}  (open it to check the result)`);
  } finally {
    try {
      work.removeCallback();
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  log.error('test-video failed', e);
  process.exit(1);
});
