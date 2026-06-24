/**
 * Harness for the body builder. Point it at a locally-downloaded generated bundle
 * (a card's Drive folder: audio/full.mp3, episode_package.json, reference_enhanced.png,
 * images_2/, optionally an .srt). Prints the parsed plan, then optionally renders.
 *
 *   pnpm --filter @slate/watcher test-body "<bundle dir>"            # plan only
 *   pnpm --filter @slate/watcher test-body "<bundle dir>" --full     # all stills, capped 7s (fast stitch check)
 *   pnpm --filter @slate/watcher test-body "<bundle dir>" --real     # all stills, REAL durations (the actual body)
 *   …optional: --cap=10   (override the per-still cap for --full)
 *
 * Output is written into the bundle folder (body_test.mp4 / body_full.mp4).
 */
import { probeVideo } from '../src/video';
import { parseBodyPlan } from '../src/episodePackage';
import { buildBody } from '../src/body';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Find a full-voiceover SRT in the bundle, if one exists. */
function findSrt(bundle: string): string | undefined {
  for (const dir of [bundle, path.join(bundle, 'audio'), path.join(bundle, 'captions')]) {
    if (!fs.existsSync(dir)) continue;
    const f = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith('.srt'));
    if (f) return path.join(dir, f);
  }
  return undefined;
}

async function main() {
  const bundle = process.argv[2];
  if (!bundle || bundle.startsWith('--')) throw new Error('usage: test-body <bundle dir> [--full|--real] [--cap=N]');
  const real = process.argv.includes('--real');
  const full = real || process.argv.includes('--full');
  const capArg = process.argv.find((a) => /^--cap=/.test(a));

  const vo = await probeVideo(path.join(bundle, 'audio', 'full.mp3'));
  const plan = parseBodyPlan(bundle, vo.duration);
  const srt = findSrt(bundle);

  console.log(`subject=${plan.subjectName}`);
  console.log(`intro_line(${plan.introLine.length} chars) -> intro VO ~${plan.bodyStartSec.toFixed(1)}s`);
  console.log(`body VO ${plan.bodyDurationSec.toFixed(1)}s, ${plan.stills.length} stills, srt=${srt ? path.basename(srt) : 'none'}\n`);
  console.log('still'.padEnd(14) + 'start'.padStart(9) + 'dur'.padStart(9));
  for (const s of plan.stills) {
    console.log(s.label.padEnd(14) + s.startSec.toFixed(1).padStart(9) + s.durationSec.toFixed(1).padStart(9) + '  ' + path.basename(s.imagePath));
  }
  console.log('\nCTAs:');
  for (const c of plan.ctas) console.log(`  [${c.kind}] @${c.startSec.toFixed(1)}s for ${c.durationSec.toFixed(1)}s`);

  if (!full && !process.argv.includes('--render')) {
    console.log('\n(plan only — pass --real for the actual body, or --full for a fast capped stitch)');
    return;
  }

  // --real: real durations (the true body). --full: cap each still (fast stitch check).
  // --n=K: only the first K stills (handy for a quick zoom/transition check).
  const cap = real ? 0 : capArg ? Number(capArg.split('=')[1]) : 7;
  const nArg = process.argv.find((a) => /^--n=/.test(a));
  const limit = nArg ? Number(nArg.split('=')[1]) : plan.stills.length;
  const subset = plan.stills.slice(0, limit).map((s) => ({ ...s, durationSec: cap > 0 ? Math.min(s.durationSec, cap) : s.durationSec }));
  let acc = 0;
  for (const s of subset) { s.startSec = acc; acc += s.durationSec; }

  const out = path.join(bundle, real ? 'body_full.mp4' : 'body_test.mp4');
  const work = path.join(os.tmpdir(), 'slate-body-work');
  console.log(`\nrendering ${subset.length} stills${cap ? ` @≤${cap}s` : ' @ real durations'} = ${(acc / 60).toFixed(1)} min → ${out}\n`);
  await buildBody({
    stills: subset,
    voiceoverPath: path.join(bundle, 'audio', 'full.mp3'),
    bodyStartSec: plan.bodyStartSec,
    bodyDurationSec: acc,
    srtPath: srt,
    ctas: plan.ctas,
    outPath: out,
    workDir: work,
  });
  console.log(`\nrendered ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
