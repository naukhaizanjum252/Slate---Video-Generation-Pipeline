/**
 * Intro compositor (video mode). Edits the card's INTRO clip into the full
 * branded intro, then the pipeline concatenates the main episode video after it.
 *
 * Timeline (pause point = EFFECT_PAUSING_TIMESTAMP):
 *   0 → T            intro plays normally
 *   at T             freeze frame · camera-click · white flash · zoom-in (held)
 *   T + ENTRANCE     voiceover (loud) + bg music (quiet) + subject-name text
 *   end of voiceover camera-glitch (screen-blended) + camera-click · zoom resets · unfreeze
 *   T → end          intro resumes
 *   last END_TAIL    film-grain audio rises; boom at the very end
 *   + BLACK          black screen as the transition into the main video
 *
 * Built in labelled ffmpeg passes (so failures point at a stage and we can tune
 * each beat). FIRST CUT — look/timing knobs below are meant to be tuned against a
 * real clip via the test-video-ui tool. Assets resolve from INTRO_ASSETS_DIR (or
 * the bundled apps/watcher/src/assets) by basename, any extension.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as tmp from 'tmp';
import { run, FFMPEG, probeVideo } from './video';
import { createLogger } from './logger';

const log = createLogger('intro');

/** Run ffmpeg and collect raw stdout as a Buffer (run() returns a string, which
 *  corrupts binary). Used to read the alpha plane for trimming. */
function runBuffer(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d) => chunks.push(d as Buffer));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${bin} exited ${code}`))));
  });
}

/**
 * Trim a transparent PNG to the bounding box of its non-transparent pixels, so a
 * graphic centred on a big empty canvas (like the disclaimer) can actually hug a
 * corner. Scans the alpha plane; returns a cropped PNG path (or the original if
 * anything fails / nothing to trim).
 */
async function trimTransparent(src: string, work: string): Promise<string> {
  try {
    const info = await probeVideo(src);
    const W = info.width;
    const H = info.height;
    const buf = await runBuffer(FFMPEG, ['-v', 'error', '-i', src, '-vf', 'alphaextract,format=gray', '-f', 'rawvideo', '-']);
    if (buf.length < W * H) return src;
    const TH = 16;
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        if (buf[row + x] > TH) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return src; // fully transparent → nothing to trim
    const pad = 8;
    const x = Math.max(0, minX - pad);
    const y = Math.max(0, minY - pad);
    let cw = Math.min(W - x, maxX - minX + 1 + 2 * pad);
    let ch = Math.min(H - y, maxY - minY + 1 + 2 * pad);
    cw -= cw % 2;
    ch -= ch % 2;
    if (cw <= 0 || ch <= 0) return src;
    const out = path.join(work, 'wm_trim.png');
    await run(FFMPEG, ['-y', '-i', src, '-vf', `crop=${cw}:${ch}:${x}:${y}`, out]);
    return out;
  } catch (e) {
    log.warn(`watermark trim failed (${e instanceof Error ? e.message : e}); using untrimmed image`);
    return src;
  }
}

// ── Tunable knobs (defaults; overridable per-run, e.g. from the test UI) ──
export interface IntroOptions {
  entranceSec: number; // pause → voiceover/text appear
  exitSec: number; // glitch / unfreeze beat at the end of the freeze
  flashSec: number; // white flash duration at the pause
  zoom: number; // freeze zoom-in factor (1 = none)
  endTailSec: number; // film-grain rise window before the intro ends
  blackSec: number; // trailing black screen
  voVolume: number; // voiceover (foreground)
  musicVolume: number; // background music (under the voiceover)
  grainVolume: number; // film-grain peak (overpowers the video by the end)
  boomVolume: number; // end-of-clip boom
  clickVolume: number; // camera click (pause + glitch)
  glitchOpacity: number; // glitch overlay strength (0–1)
}

export const INTRO_DEFAULTS: IntroOptions = {
  entranceSec: 1.0,
  exitSec: 0.9,
  flashSec: 0.12,
  zoom: 1.2,
  endTailSec: 3.0,
  blackSec: 2.0,
  voVolume: 1.0,
  musicVolume: 0.5,
  grainVolume: 2.0,
  boomVolume: 1.0,
  clickVolume: 1.0,
  glitchOpacity: 1.0,
};

const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2'];

export interface IntroInputs {
  introVideo: string;
  voiceover: string | null; // audio clip; its length sets how long the freeze holds
  subjectName: string;
  effectTimestampSec: number;
  outPath: string;
}

/** Resolve the assets dir (INTRO_ASSETS_DIR override, else bundled). */
function assetsDir(): string {
  const override = process.env.INTRO_ASSETS_DIR?.trim();
  const candidates = [
    ...(override ? [override] : []),
    path.resolve(__dirname, 'assets'),
    path.resolve(__dirname, '../assets'),
    path.resolve(__dirname, '../src/assets'),
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
}

/** Find an asset by basename in a category folder, any extension. */
function findAsset(category: string, base: string): string | null {
  const dir = path.join(assetsDir(), category);
  if (!fs.existsSync(dir)) return null;
  const hit = fs
    .readdirSync(dir)
    .find((f) => f.toLowerCase().startsWith(`${base.toLowerCase()}.`) && !f.startsWith('.'));
  return hit ? path.join(dir, hit) : null;
}

function requireAsset(category: string, base: string): string {
  const p = findAsset(category, base);
  if (!p) {
    throw new Error(
      `Missing intro asset ${category}/${base}.* in ${assetsDir()} (set INTRO_ASSETS_DIR or add the file).`,
    );
  }
  return p;
}

/** A usable font: explicit override → bundled font → common OS fallback. */
function fontPath(): string {
  const env = process.env.INTRO_FONT_PATH?.trim();
  if (env && fs.existsSync(env)) return env;
  const dir = path.join(assetsDir(), 'fonts');
  if (fs.existsSync(dir)) {
    const f = fs.readdirSync(dir).find((x) => /\.(ttf|otf)$/i.test(x) && !x.startsWith('.'));
    if (f) return path.join(dir, f);
  }
  const fallbacks = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ];
  return fallbacks.find((f) => fs.existsSync(f)) ?? fallbacks[0];
}

/** Prefer a BOLD face for the name plate (falls back to the regular font). */
function boldFontPath(): string {
  const env = process.env.INTRO_BOLD_FONT_PATH?.trim();
  if (env && fs.existsSync(env)) return env;
  const dir = path.join(assetsDir(), 'fonts');
  if (fs.existsSync(dir)) {
    const f = fs.readdirSync(dir).find((x) => /bold.*\.(ttf|otf)$/i.test(x) && !x.startsWith('.'));
    if (f) return path.join(dir, f);
  }
  const fallbacks = [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  ];
  return fallbacks.find((f) => fs.existsSync(f)) ?? fontPath();
}

const ms = (sec: number) => Math.max(0, Math.round(sec * 1000));
const adelayStereo = (sec: number) => `adelay=${ms(sec)}|${ms(sec)}`;

/**
 * Build the finished intro. Returns outPath. Self-contained temp cleanup.
 */
export async function buildIntro(inp: IntroInputs, opts?: Partial<IntroOptions>): Promise<string> {
  const o = { ...INTRO_DEFAULTS, ...(opts ?? {}) };
  const ENTRANCE_SEC = o.entranceSec;
  const EXIT_SEC = o.exitSec;
  const FLASH_SEC = o.flashSec;
  const ZOOM = o.zoom;
  const END_TAIL_SEC = o.endTailSec;
  const BLACK_SEC = o.blackSec;
  const VO_VOLUME = o.voVolume;
  const MUSIC_VOLUME = o.musicVolume;
  const GRAIN_VOLUME = o.grainVolume;
  const BOOM_VOLUME = o.boomVolume;
  const CLICK_VOLUME = o.clickVolume;
  const GLITCH_OPACITY = o.glitchOpacity;

  const info = await probeVideo(inp.introVideo);
  const W = info.width;
  const H = info.height;
  const fps = info.fps;
  const Din = info.duration || 0;

  // Clamp the pause point inside the clip.
  let T = inp.effectTimestampSec;
  if (!(T > 0) || (Din && T >= Din)) {
    const clamped = Din ? Math.min(Math.max(T, 0.1), Din - 0.1) : Math.max(T, 0.1);
    log.warn(`Effect timestamp ${T}s out of range (duration ${Din}s) — clamping to ${clamped}s`);
    T = clamped;
  }

  const V = inp.voiceover ? (await probeVideo(inp.voiceover)).duration || 0 : 0;
  const FREEZE = ENTRANCE_SEC + V + EXIT_SEC;
  const glitchStart = Math.max(0, FREEZE - EXIT_SEC);
  const Dpart = Math.max(0.1, Din - T);

  const cameraClick = requireAsset('sfx', 'camera_click');
  const filmGrain = requireAsset('sfx', 'film_grain');
  const boom = requireAsset('sfx', 'boom');
  const music = requireAsset('music', 'background_track');
  const glitch = requireAsset('overlays', 'glitch');
  const font = fontPath();

  const zw = Math.trunc((W * ZOOM) / 2) * 2;
  const zh = Math.trunc((H * ZOOM) / 2) * 2;

  const work = tmp.dirSync({ prefix: 'slate-intro-', unsafeCleanup: true });
  try {
    const partA = path.join(work.name, 'a.mp4');
    const freezeV = path.join(work.name, 'freeze_v.mp4');
    const freeze = path.join(work.name, 'freeze.mp4');
    const partB = path.join(work.name, 'b.mp4');
    const black = path.join(work.name, 'black.mp4');
    const nameTxt = path.join(work.name, 'name.txt');
    fs.writeFileSync(nameTxt, inp.subjectName ?? '');

    // 1) Part A — intro up to the pause.
    log.info(`[intro] partA 0..${T.toFixed(2)}s`);
    await run(FFMPEG, ['-y', '-i', inp.introVideo, '-t', T.toFixed(3),
      '-vf', `scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p`, ...ENC, partA]);

    // 2) Freeze VIDEO: zoom-in + white flash + subject-name text + glitch (screen-blended).
    // drawtext needs an ffmpeg built with libfreetype; if it's absent we render
    // the rest without the name rather than failing the whole intro.
    const fontSize = Math.round(H / 16);
    const freezeVideoArgs = (withText: boolean): string[] => {
      const drawName =
        withText && inp.subjectName
          ? `,drawtext=fontfile='${font}':textfile='${nameTxt}':fontcolor=white:fontsize=${fontSize}:` +
            `x=(w-text_w)/2:y=h*0.76:box=1:boxcolor=black@0.45:boxborderw=24:` +
            `alpha='if(lt(t,${ENTRANCE_SEC}),0,min(1,(t-${ENTRANCE_SEC})/0.4))'`
          : '';
      return [
        '-y',
        '-ss', T.toFixed(3), '-i', inp.introVideo, // seek to the pause point
        '-i', glitch,
        '-filter_complex',
        // Hold the frame at T entirely in YUV (no PNG/RGB roundtrip → no color shift):
        // keep ~1 frame, clone it for the freeze, then zoom/flash/text.
        `[0:v]trim=end=0.05,setpts=PTS-STARTPTS,scale=${zw}:${zh},crop=${W}:${H},setsar=1,` +
          `tpad=stop_duration=${FREEZE.toFixed(3)}:stop_mode=clone,fps=${fps},trim=0:${FREEZE.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,` +
          `fade=t=in:st=0:d=${FLASH_SEC}:color=white${drawName}[base];` +
          `[1:v]scale=${W}:${H},fps=${fps},format=yuv420p,tpad=start_duration=${glitchStart.toFixed(3)},` +
          `trim=0:${FREEZE.toFixed(3)},setpts=PTS-STARTPTS[g];` +
          `[base][g]blend=all_mode=screen:all_opacity=${GLITCH_OPACITY}:shortest=1[v]`,
        '-map', '[v]', '-an', '-t', FREEZE.toFixed(3),
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', freezeV,
      ];
    };
    log.info(`[intro] freeze video (${FREEZE.toFixed(2)}s, zoom ${ZOOM})`);
    try {
      await run(FFMPEG, freezeVideoArgs(true));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/drawtext/i.test(msg) && inp.subjectName) {
        log.warn(
          'This ffmpeg has no drawtext filter — rendering the intro WITHOUT the subject-name text. ' +
            'Install an ffmpeg built with --enable-libfreetype to enable it.',
        );
        await run(FFMPEG, freezeVideoArgs(false));
      } else {
        throw e;
      }
    }

    // 4) Freeze AUDIO + mux: camera-click at pause, voiceover after ENTRANCE,
    // camera-click at the glitch. (Background music is a global bed added at the end.)
    log.info('[intro] freeze audio + mux');
    const aInputs = ['-i', freezeV, '-i', cameraClick];
    const aFilters = ['[1:a]asplit=2[ca][cb]', `[ca]${adelayStereo(0)},volume=${CLICK_VOLUME}[c1]`, `[cb]${adelayStereo(glitchStart)},volume=${CLICK_VOLUME}[c2]`];
    const aMix = ['[c1]', '[c2]'];
    if (inp.voiceover && V > 0) {
      aInputs.push('-i', inp.voiceover);
      aFilters.push(`[2:a]${adelayStereo(ENTRANCE_SEC)},volume=${VO_VOLUME}[vo]`);
      aMix.push('[vo]');
    }
    // apad=whole_dur pads to an EXACT length and stops (bare apad pads forever).
    aFilters.push(`${aMix.join('')}amix=inputs=${aMix.length}:normalize=0:duration=longest,apad=whole_dur=${FREEZE.toFixed(3)}[a]`);
    await run(FFMPEG, ['-y', ...aInputs, '-filter_complex', aFilters.join(';'),
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-t', FREEZE.toFixed(3), freeze]);

    // 5) Part B — intro resumes; film-grain rises in the last END_TAIL (boom is
    // on the black screen that follows, so it lands AFTER the grain).
    const fgStart = Math.max(0, Dpart - END_TAIL_SEC);
    log.info(`[intro] partB ${T.toFixed(2)}..end (${Dpart.toFixed(2)}s)`);
    const partBInputs = ['-y', '-ss', T.toFixed(3), '-i', inp.introVideo, '-i', filmGrain];
    // The intro's own audio — synthesize silence if the clip has no audio track.
    let a0Filter = '[0:a]volume=1[a0]';
    if (!info.hasAudio) {
      partBInputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      a0Filter = `[2:a]atrim=0:${Dpart.toFixed(3)}[a0]`;
    }
    await run(FFMPEG, [
      ...partBInputs,
      '-filter_complex',
      `[0:v]scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p[v];` +
        `${a0Filter};` +
        `[1:a]atrim=0:${END_TAIL_SEC},${adelayStereo(fgStart)},afade=t=in:st=${fgStart.toFixed(3)}:d=${END_TAIL_SEC},volume=${GRAIN_VOLUME}[fg];` +
        `[a0][fg]amix=inputs=2:normalize=0:duration=first[a]`,
      '-map', '[v]', '-map', '[a]', '-t', Dpart.toFixed(3), ...ENC, partB,
    ]);

    // 6) Black transition — the boom hits here, right after the film grain.
    await run(FFMPEG, [
      '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${BLACK_SEC}`,
      '-i', boom,
      '-filter_complex', `[1:a]volume=${BOOM_VOLUME},apad=whole_dur=${BLACK_SEC.toFixed(3)}[a]`,
      '-map', '0:v', '-map', '[a]', '-t', String(BLACK_SEC), ...ENC, black,
    ]);

    // 7) Concat A + freeze + B + black into the intro (no music bed yet).
    const introNoMusic = path.join(work.name, 'intro_nomusic.mp4');
    const listFile = path.join(work.name, 'list.txt');
    fs.writeFileSync(
      listFile,
      [partA, freeze, partB, black].map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
    );
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, ...ENC, introNoMusic]);

    // 8) Background-music bed under the WHOLE intro (loops to cover its length).
    log.info('[intro] music bed');
    await run(FFMPEG, [
      '-y',
      '-i', introNoMusic,
      '-stream_loop', '-1', '-i', music,
      '-filter_complex', `[1:a]volume=${MUSIC_VOLUME}[m];[0:a][m]amix=inputs=2:normalize=0:duration=first[a]`,
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', inp.outPath,
    ]);
    log.info(`[intro] done -> ${inp.outPath}`);
    return inp.outPath;
  } finally {
    try {
      work.removeCallback();
    } catch {
      /* ignore */
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Free-form / absolute-timeline build (NLE model).
 *
 * Same render techniques as buildIntro, but driven by an explicit timeline:
 * the structure (pause point, freeze length, black) + every effect/sound placed
 * at an ABSOLUTE time on the final output. Visual effects (flash/zoom/glitch/
 * text) live within the freeze block; audio clips can be placed anywhere.
 * ───────────────────────────────────────────────────────────────────────── */

export interface IntroAudioClip {
  kind: 'voiceover' | 'music' | 'grain' | 'boom' | 'click';
  start: number; // absolute sec on the final timeline
  duration?: number; // sec; omitted = natural length (music loops to fit)
  volume: number;
  fadeInSec?: number;
}

export interface IntroSpec {
  pauseAtSec: number; // where the freeze is inserted in the SOURCE clip
  freezeDurationSec: number;
  blackSec: number;
  zoom: number;
  flashSec: number;
  glitchAtSec: number; // absolute time of the glitch (clamped into the freeze)
  glitchDurationSec: number;
  glitchOpacity: number;
  textStartSec: number; // absolute time the name appears (clamped into the freeze)
  subjectName: string;
  // Centre of the name plate's white bar, normalized 0..1 (so it can sit on the
  // subject instead of a fixed spot). Omitted = the plate's natural position.
  textCenterX?: number;
  textCenterY?: number;
  audio: IntroAudioClip[];
  // Visual effects are each optional (default on). Lets the editor add/remove them.
  hasFlash?: boolean;
  hasGlitch?: boolean;
  hasText?: boolean;
  hasWatermark?: boolean; // bottom-left PNG over the whole intro (needs the asset)
  // Multiple instances (NLE): when present these win over the single fields above,
  // so flashes/glitches can be added more than once at different times.
  flashes?: { atSec: number }[];
  glitches?: { atSec: number; opacity: number }[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Shift every SRT timestamp by `offsetSec` (so voiceover-relative cues land at
 *  their absolute time on the final timeline). Accepts ',' or '.' ms separators. */
function shiftSrt(srcSrt: string, offsetSec: number, destSrt: string): void {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const p3 = (n: number) => String(n).padStart(3, '0');
  const txt = fs.readFileSync(srcSrt, 'utf8');
  const shifted = txt.replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g, (_m, h, m, s, ms) => {
    let t = +h * 3600 + +m * 60 + +s + +ms / 1000 + offsetSec;
    if (t < 0) t = 0;
    const hh = Math.floor(t / 3600);
    const mm = Math.floor((t % 3600) / 60);
    const ss = Math.floor(t % 60);
    const mmm = Math.round((t - Math.floor(t)) * 1000);
    return `${p2(hh)}:${p2(mm)}:${p2(ss)},${p3(mmm)}`;
  });
  fs.writeFileSync(destSrt, shifted);
}

// Caption look (white, bold, black outline, bottom-centre) — like the reference.
const CAPTION_STYLE =
  "FontName=Arial,Fontsize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.4,Shadow=0,Alignment=2,MarginV=60";

/**
 * Build the intro from an absolute timeline spec. Returns outPath. `captionsSrtPath`
 * (optional) is an SRT whose cues are relative to the voiceover; it's shifted to
 * the voiceover's absolute start and burned in (needs an ffmpeg with libass).
 */
export async function buildIntroSpec(
  introVideo: string,
  voiceoverPath: string | null,
  spec: IntroSpec,
  outPath: string,
  captionsSrtPath: string | null = null,
): Promise<string> {
  const info = await probeVideo(introVideo);
  const W = info.width;
  const H = info.height;
  const fps = info.fps;
  const Dclip = info.duration || 0;

  let T = spec.pauseAtSec;
  if (!(T > 0) || (Dclip && T >= Dclip)) {
    T = Dclip ? Math.min(Math.max(T, 0.1), Dclip - 0.1) : Math.max(T, 0.1);
  }
  const F = Math.max(0.1, spec.freezeDurationSec);
  const B = Math.max(0, spec.blackSec);
  const Dpart2 = Math.max(0.1, Dclip - T);
  const totalD = T + F + Dpart2 + B;
  const textRel = clamp(spec.textStartSec - T, 0, F);

  const cameraClick = requireAsset('sfx', 'camera_click');
  const filmGrain = requireAsset('sfx', 'film_grain');
  const boomAsset = requireAsset('sfx', 'boom');
  const music = requireAsset('music', 'background_track');
  const glitch = requireAsset('overlays', 'glitch');
  const textAnim = findAsset('overlays', 'text_animation'); // green-screen name plate
  const whiteFlash = findAsset('overlays', 'white_flash'); // full-frame flash clip (screen-blended)
  const watermark = findAsset('watermark', 'watermark'); // optional disclaimer, bottom-left
  const hasWm = spec.hasWatermark !== false && !!watermark;

  const SILENCE = 'anullsrc=channel_layout=stereo:sample_rate=48000';

  const work = tmp.dirSync({ prefix: 'slate-introspec-', unsafeCleanup: true });
  try {
    const seg1 = path.join(work.name, 's1.mp4');
    const freezeV = path.join(work.name, 'fz_v.mp4');
    const freeze = path.join(work.name, 'fz.mp4');
    const seg2 = path.join(work.name, 's2.mp4');
    const black = path.join(work.name, 'bk.mp4');
    const base = path.join(work.name, 'base.mp4');
    const nameTxt = path.join(work.name, 'name.txt');
    fs.writeFileSync(nameTxt, spec.subjectName ?? '');

    // 1) seg1 = clip [0, T]
    await run(FFMPEG, ['-y', '-i', introVideo, '-t', T.toFixed(3),
      '-vf', `scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p`, ...ENC, seg1]);

    // 2) freeze video: held frame (native color); flash / text / glitch each optional.
    const hasFlash = spec.hasFlash !== false && spec.flashSec > 0;
    const hasGlitch = spec.hasGlitch !== false;
    const hasText = spec.hasText !== false && !!spec.subjectName;
    const useNameplate = hasText && !!textAnim;

    // Green-screen "SUSPECT" name plate: it wipes in, then holds. The name fades
    // in shortly after (NAME_WIPE_SEC), centred in the white bar (black, semi-bold).
    // Positions are normalized to the asset @1920x1080. textCenterX/Y position the
    // pin DOT — it should point at the subject — and the bar + name hang down-left
    // of it (preserving the asset's layout), so the dot "connects" to the subject.
    const NAME_WIPE_SEC = 1.0;
    const GREEN_KEY = '0x31fe02';
    const BAR_NAT_CX = 0.461;
    const BAR_NAT_CY = 0.537;
    const DOT_NAT_X = 0.601;
    const DOT_NAT_Y = 0.421;
    const dotX = clamp(spec.textCenterX ?? DOT_NAT_X, 0.05, 0.95);
    const dotY = clamp(spec.textCenterY ?? DOT_NAT_Y, 0.05, 0.95);
    const offX = Math.round((dotX - DOT_NAT_X) * W); // plate translation (anchored on the dot)
    const offY = Math.round((dotY - DOT_NAT_Y) * H);
    const nameCX = BAR_NAT_CX + (dotX - DOT_NAT_X); // bar centre travels with the plate
    const nameCY = BAR_NAT_CY + (dotY - DOT_NAT_Y);
    const nameStartRel = clamp(textRel + NAME_WIPE_SEC, 0, F);
    const nChars = Math.max(1, (spec.subjectName ?? '').length);
    const baseFs = Math.round(H * 0.05);
    const fitFs = Math.floor((0.30 * W) / (0.6 * nChars)); // shrink to the bar's inner width
    const nameFs = Math.max(16, Math.min(baseFs, fitFs));
    const boldFont = boldFontPath();
    // Centred in the bar; black, semi-bold (bold face, no extra border). No leading
    // comma — it follows a stream label, not a filter.
    const drawName =
      `drawtext=fontfile='${boldFont}':textfile='${nameTxt}':fontcolor=black:fontsize=${nameFs}:` +
      `x=${nameCX.toFixed(4)}*w-text_w/2:y=${nameCY.toFixed(4)}*h-text_h/2:` +
      `enable='gte(t,${nameStartRel.toFixed(3)})':alpha='min(1,max(0,(t-${nameStartRel.toFixed(3)})/0.4))'`;

    const flashLen = Math.min(F, Math.max(0.2, spec.flashSec || 0.6));

    // Slow zoom-in on the frozen frame: a CONSTANT-RATE push-in that keeps creeping
    // in the whole freeze (it doesn't ramp to a target and settle). The rate is fixed
    // per second regardless of freeze length, so the motion always reads the same.
    // spec.zoom sets the speed: it's the zoom reached after ZOOM_REF_SEC, then it
    // simply keeps going at that rate. zoompan animates per output frame via `on`.
    const endZoom = spec.zoom > 1 ? spec.zoom : 1;
    const ZOOM_REF_SEC = 10;
    const zRate = (endZoom - 1) / (ZOOM_REF_SEC * fps); // per output frame
    const fzFrames = Math.max(2, Math.round(F * fps));
    // zoompan jitters because it crops an INTEGER window from the frame each step.
    // Fix: supersample the still (2–4×) and let zoompan generate the whole move from
    // ONE frame, so the per-frame crop steps are sub-pixel and the downscale to W×H
    // anti-aliases them — a smooth, non-shaky push-in.
    const zUp = Math.min(4, Math.max(2, Math.floor(5760 / W) || 2));
    const zoomPan =
      `scale=${W * zUp}:${H * zUp}:flags=bicubic,setsar=1,` +
      `zoompan=z='1+${zRate.toFixed(8)}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
      `d=${fzFrames}:s=${W}x${H}:fps=${fps},setsar=1`;

    // Multiple flashes / glitches: an explicit array wins; otherwise fall back to
    // the single legacy field. Times are clamped to freeze-relative seconds.
    const flashRels = (
      spec.flashes && spec.flashes.length ? spec.flashes.map((f) => f.atSec) : hasFlash ? [T] : []
    ).map((s) => clamp(s - T, 0, F));
    const glitchSpecs = (
      spec.glitches && spec.glitches.length
        ? spec.glitches
        : hasGlitch
          ? [{ atSec: spec.glitchAtSec, opacity: spec.glitchOpacity }]
          : []
    ).map((g) => ({ rel: clamp(g.atSec - T, 0, F), opacity: g.opacity }));
    const useFlashClips = !!whiteFlash && flashRels.length > 0;

    const freezeArgs = (withText: boolean): string[] => {
      const inputs = ['-y', '-ss', T.toFixed(3), '-i', introVideo];
      let n = 1;
      const glitchIdx = glitchSpecs.map(() => { const i = n++; inputs.push('-i', glitch); return i; });
      const flashIdx = useFlashClips ? flashRels.map(() => { const i = n++; inputs.push('-i', whiteFlash as string); return i; }) : [];
      let ti = -1;
      if (useNameplate) { ti = n++; inputs.push('-i', textAnim as string); }

      // Synthetic flash only when there's no flash clip (one, at the freeze start).
      // Flash + glitch screen-blend in planar RGB (gbrp) — blending in YUV tints the
      // frame pink. Convert to yuv420p once, then overlay the plate + name.
      const synthFlash = !useFlashClips && flashRels.length ? `,fade=t=in:st=0:d=${spec.flashSec}:color=white` : '';
      const parts: string[] = [];
      parts.push(
        `[0:v]trim=end_frame=1,setpts=PTS-STARTPTS,${zoomPan},` +
        `format=rgb24${synthFlash},format=gbrp[bg]`,
      );
      let comp = '[bg]';
      // Each flash: white→black clip, delayed to its time, padded with black so it
      // flashes once (screen-blend of black = no change).
      flashIdx.forEach((idx, j) => {
        parts.push(
          `[${idx}:v]scale=${W}:${H},fps=${fps},format=gbrp,trim=0:${flashLen.toFixed(3)},setpts=PTS-STARTPTS,` +
          `tpad=start_duration=${flashRels[j].toFixed(3)},tpad=stop_duration=${F.toFixed(3)},trim=0:${F.toFixed(3)},setpts=PTS-STARTPTS[wf${j}]`,
        );
        parts.push(`${comp}[wf${j}]blend=all_mode=screen:shortest=1[bf${j}]`);
        comp = `[bf${j}]`;
      });
      // Each glitch: screen-blended at its time with its own opacity.
      glitchIdx.forEach((idx, j) => {
        parts.push(
          `[${idx}:v]scale=${W}:${H},fps=${fps},format=gbrp,tpad=start_duration=${glitchSpecs[j].rel.toFixed(3)},` +
          `tpad=stop_duration=${F.toFixed(3)},trim=0:${F.toFixed(3)},setpts=PTS-STARTPTS[g${j}]`,
        );
        parts.push(`${comp}[g${j}]blend=all_mode=screen:all_opacity=${glitchSpecs[j].opacity}:shortest=1[gc${j}]`);
        comp = `[gc${j}]`;
      });
      parts.push(`${comp}format=yuv420p[byuv]`);
      let cur = '[byuv]';
      if (useNameplate) {
        // Key out the green (tight blend → solid, fully-opaque bar), hold the last
        // frame to fill the freeze, shift so the wipe STARTS at textRel, and place
        // the plate at the requested centre.
        const dur = Math.max(0.1, F - textRel);
        parts.push(
          `[${ti}:v]chromakey=${GREEN_KEY}:0.30:0.04,scale=${W}:${H},fps=${fps},format=yuva420p,` +
          `tpad=stop_duration=${F.toFixed(3)}:stop_mode=clone,trim=0:${dur.toFixed(3)},` +
          `setpts=PTS-STARTPTS+${textRel.toFixed(3)}/TB[np]`,
        );
        parts.push(`${cur}[np]overlay=${offX}:${offY}:eof_action=pass:format=auto[ov]`);
        cur = '[ov]';
      }
      const nameF = withText && hasText ? `${drawName},` : '';
      parts.push(`${cur}${nameF}format=yuv420p[v]`);
      return [...inputs, '-filter_complex', parts.join(';'), '-map', '[v]', '-an', '-t', F.toFixed(3),
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', freezeV];
    };
    try {
      await run(FFMPEG, freezeArgs(true));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/drawtext/i.test(msg) && hasText) {
        log.warn('No drawtext filter — rendering the name plate WITHOUT the name letters.');
        await run(FFMPEG, freezeArgs(false));
      } else {
        throw e;
      }
    }
    // Give the freeze a silent audio track so concat stays uniform.
    await run(FFMPEG, ['-y', '-i', freezeV, '-f', 'lavfi', '-i', SILENCE,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-t', F.toFixed(3), freeze]);

    // 3) seg2 = clip [T, end]
    await run(FFMPEG, ['-y', '-ss', T.toFixed(3), '-i', introVideo,
      '-vf', `scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p`, '-t', Dpart2.toFixed(3), ...ENC, seg2]);

    // 4) black
    await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${B}`,
      '-f', 'lavfi', '-i', SILENCE, '-t', String(B), ...ENC, black]);

    // 5) base = concat (video + base audio: clip audio in seg1/seg2, silence elsewhere)
    const listFile = path.join(work.name, 'list.txt');
    fs.writeFileSync(listFile, [seg1, freeze, seg2, black].map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, ...ENC, base]);

    // 6) mix every audio clip onto the base audio at its absolute time
    const aIn: string[] = ['-i', base];
    const aF: string[] = [];
    const mix: string[] = ['[0:a]'];
    let idx = 1;
    for (const c of spec.audio) {
      const src =
        c.kind === 'voiceover' ? voiceoverPath
          : c.kind === 'music' ? music
            : c.kind === 'grain' ? filmGrain
              : c.kind === 'boom' ? boomAsset
                : cameraClick;
      if (!src) continue; // voiceover may be absent
      if (c.kind === 'music') aIn.push('-stream_loop', '-1', '-i', src);
      else aIn.push('-i', src);
      let f = `[${idx}:a]`;
      if (c.duration && c.duration > 0) f += `atrim=0:${c.duration.toFixed(3)},`;
      f += `${adelayStereo(c.start)},`;
      if (c.fadeInSec && c.fadeInSec > 0) f += `afade=t=in:st=${c.start.toFixed(3)}:d=${c.fadeInSec.toFixed(3)},`;
      f += `volume=${c.volume}[a${idx}]`;
      aF.push(f);
      mix.push(`[a${idx}]`);
      idx++;
    }
    // Audio output: amix the clips over the base, or just the base audio.
    let audioMap = '0:a';
    if (mix.length > 1) {
      aF.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=first[a]`);
      audioMap = '[a]';
    }

    // Video output: overlay the disclaimer bottom-left (whole intro) if present.
    // Trim its transparent margins first so the text actually hugs the corner.
    let videoMap = '0:v';
    let vcodec = ['-c:v', 'copy'];
    if (hasWm) {
      const wmImg = await trimTransparent(watermark as string, work.name);
      aIn.push('-loop', '1', '-i', wmImg);
      const wmW = Math.round(W * 0.34); // legible (it's a disclaimer, not a tiny mark)
      const m = Math.round(W * 0.03);
      aF.push(`[${idx}:v]scale=${wmW}:-1[wm];[0:v][wm]overlay=x=${m}:y=H-h-${m}[v]`);
      idx++;
      videoMap = '[v]';
      vcodec = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
    }

    // If burning captions, the audio/watermark pass writes to a temp file and a
    // final subtitles pass writes outPath; otherwise it writes outPath directly.
    const preCapOut = captionsSrtPath ? path.join(work.name, 'precap.mp4') : outPath;
    const finalArgs = ['-y', ...aIn];
    if (aF.length) finalArgs.push('-filter_complex', aF.join(';'));
    finalArgs.push('-map', videoMap, '-map', audioMap, ...vcodec, '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-t', totalD.toFixed(3), preCapOut);
    await run(FFMPEG, finalArgs);

    // Captions: shift the SRT to the voiceover's absolute start, then burn it.
    if (captionsSrtPath) {
      const voClip = spec.audio.find((c) => c.kind === 'voiceover');
      const offset = voClip ? voClip.start : T; // voiceover start on the timeline
      const cc = path.join(work.name, 'cc.srt');
      shiftSrt(captionsSrtPath, offset, cc);
      log.info(`[introSpec] burning captions (offset ${offset.toFixed(2)}s)`);
      try {
        await run(FFMPEG, ['-y', '-i', preCapOut,
          '-vf', `subtitles=filename=${cc}:force_style='${CAPTION_STYLE}'`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', outPath]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/subtitles|No such filter|libass/i.test(msg)) {
          log.warn('This ffmpeg has no subtitles/libass filter — skipping captions. Install an ffmpeg built with --enable-libass.');
          fs.copyFileSync(preCapOut, outPath);
        } else {
          throw e;
        }
      }
    }
    log.info(`[introSpec] done -> ${outPath} (total ${totalD.toFixed(1)}s)`);
    return outPath;
  } finally {
    try {
      work.removeCallback();
    } catch {
      /* ignore */
    }
  }
}
