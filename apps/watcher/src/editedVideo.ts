/**
 * Build the final edited video from a generated episode bundle: an edited intro (if an
 * intro clip is supplied) + the image body (zoom + grain + CTA + captions), stitched into
 * one MP4. This is the studio-independent replacement for `/cb_build_video`.
 *
 * Shared by the live "build video" pipeline (full length) and the dashboard test edit
 * (truncated via `maxSeconds`). Inputs come entirely from the package bundle + the caller-
 * supplied intro clip / preset — no Gradio.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseBodyPlan, truncateStills } from './episodePackage';
import { buildBody } from './body';
import { probeVideo, prependIntro, FFMPEG, run } from './video';
import { specFromPreset } from './introPreset';
import { buildIntroSpec } from './intro';
import { createLogger } from './logger';

const log = createLogger('edit');

/** Locate a full-voiceover SRT in the bundle, if one exists (audio/, captions/, or root). */
export function findBundleSrt(bundle: string): string | undefined {
  for (const d of [bundle, path.join(bundle, 'audio'), path.join(bundle, 'captions')]) {
    if (!fs.existsSync(d)) continue;
    const f = fs.readdirSync(d).find((n) => n.toLowerCase().endsWith('.srt'));
    if (f) return path.join(d, f);
  }
  return undefined;
}

export interface EditedVideoOpts {
  bundleRoot: string;
  introClipPath?: string | null; // pre-downloaded Trello intro clip (null = body only)
  presetParams?: Record<string, unknown> | null;
  maxSeconds?: number; // truncate total length (test edit); omit = full episode
  srtPath?: string; // overrides the bundle auto-detect
  outPath: string;
  workDir: string;
  onProgress?: (stage: string) => void;
}

export async function buildEditedVideo(opts: EditedVideoOpts): Promise<string> {
  const { bundleRoot, outPath, workDir } = opts;
  fs.mkdirSync(workDir, { recursive: true });

  const voPath = path.join(bundleRoot, 'audio', 'full.mp3');
  if (!fs.existsSync(voPath)) throw new Error('Bundle has no audio/full.mp3 — not a full episode package');
  const vo = await probeVideo(voPath);
  const plan = parseBodyPlan(bundleRoot, vo.duration);
  const srt = opts.srtPath ?? findBundleSrt(bundleRoot);

  // 1. Edited intro (optional): intro VO = the intro-line slice of the full voiceover;
  //    pause + subject name come from the script; look from the channel preset.
  let intro: { path: string; dur: number } | null = null;
  if (opts.introClipPath) {
    opts.onProgress?.('Editing intro');
    const dir = path.join(workDir, 'intro');
    fs.mkdirSync(dir, { recursive: true });
    const introVo = path.join(dir, 'introvo.mp3');
    await run(FFMPEG, ['-y', '-i', voPath, '-t', Math.max(0.5, plan.bodyStartSec).toFixed(3), introVo]);
    const clipInfo = await probeVideo(opts.introClipPath);
    const voInfo = await probeVideo(introVo);
    const spec = specFromPreset(opts.presetParams ?? null, {
      clipDuration: clipInfo.duration,
      voDuration: voInfo.duration,
      subjectName: plan.subjectName,
      pauseAtSec: plan.pauseAtSec,
    });
    log.info(`intro: clip=${clipInfo.duration.toFixed(1)}s vo=${voInfo.duration.toFixed(1)}s pause=${plan.pauseAtSec}s name="${plan.subjectName}"`);
    const introOut = path.join(dir, 'intro.mp4');
    await buildIntroSpec(opts.introClipPath, introVo, spec, introOut, null); // intro captions: pending the SRT
    const introInfo = await probeVideo(introOut);
    intro = { path: introOut, dur: introInfo.duration };
  }

  // 2. Body — full, or truncated so intro + body fit maxSeconds.
  const bodyBudget = opts.maxSeconds ? (intro ? Math.max(10, opts.maxSeconds - intro.dur) : opts.maxSeconds) : undefined;
  const stills = bodyBudget !== undefined ? truncateStills(plan.stills, bodyBudget) : plan.stills;
  const total = stills.reduce((a, s) => a + s.durationSec, 0);
  const bodyOut = path.join(workDir, 'body.mp4');
  log.info(`body: ${stills.length} stills (${total.toFixed(0)}s)${intro ? ` + intro ${intro.dur.toFixed(0)}s` : ''} srt=${srt ? 'yes' : 'no'}`);
  await buildBody({
    stills,
    voiceoverPath: voPath,
    bodyStartSec: plan.bodyStartSec,
    bodyDurationSec: total,
    srtPath: srt,
    ctas: plan.ctas,
    outPath: bodyOut,
    workDir: path.join(workDir, 'render'),
    onProgress: opts.onProgress,
  });

  // 3. Stitch the intro on the front (or the body is the whole thing).
  if (intro) {
    opts.onProgress?.('Stitching intro');
    await prependIntro(intro.path, bodyOut, outPath);
  } else {
    fs.renameSync(bodyOut, outPath);
  }
  return outPath;
}
