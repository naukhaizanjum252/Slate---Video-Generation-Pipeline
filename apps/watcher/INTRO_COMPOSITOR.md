# Intro compositor — implementation reference

Living doc for the **video-mode intro edit**: what it does, how it's built, every
asset/knob, the test editor, and what's still not wired into production. The
original agreed spec is in [`VIDEO_INTRO_SPEC.md`](./VIDEO_INTRO_SPEC.md); **this
file is the source of truth for what the code actually does.**

> TL;DR: `src/intro.ts` → `buildIntroSpec()` is the real compositor. It's driven by
> an absolute-timeline `IntroSpec`. The `scripts/test-video-ui.ts` NLE editor is the
> only thing calling it today. The production pipeline still uses the OLD first-cut
> effect (`applyFreezeFlashBoom` + `prependIntro`) and has NOT been switched over yet.

---

## 1. The flow (what the finished intro looks like)

For a channel in **video mode**, per Trello card:

```
[ clip 0→T ] → [ FREEZE (held frame, T..T+F) ] → [ clip T→end ] → [ black ] → (main video stitched after)
```

During the **freeze** (the held frame at the pause point `T`, length `F`):
1. **Camera flash** — your `white_flash.mp4`, screen-blended at the pause (+ camera-click SFX).
2. **Slow zoom-in** — a constant-rate push-in on the frozen frame the whole time.
3. **Name plate** — the green-screen `text_animation.mp4` wipes in; the **subject name**
   (black, centred, semi-bold) fades into the white bar ~1s later.
4. **Voiceover** (foreground) + **background music** (quieter) play; **captions** burn in.
5. **Glitch** — `glitch.mp4` screen-blended near the end (the "unfreeze" beat).
6. **Film grain** rises, then **boom** at the very end → **black** → main video.

A **disclaimer/watermark** sits bottom-left for the whole intro.

Freeze length `F` ≈ entrance time + voiceover length + exit beat.

---

## 2. Files

| File | Role |
|---|---|
| `src/intro.ts` | **The compositor.** `buildIntroSpec()` (current) + `buildIntro()` (old relative-timeline variant, unused by the editor). |
| `src/video.ts` | ffmpeg helpers: `run`, `probeVideo`, `FFMPEG`/`FFPROBE`, plus the OLD `applyFreezeFlashBoom`/`prependIntro` used by production today. |
| `src/effects.ts` | Parses `EFFECT_PAUSING_TIMESTAMP` from the card brief (`MM.SS`/`MM:SS`/`HH:MM:SS`/bare seconds; **dot = field separator**, so `00.03` = 3s). |
| `scripts/test-video-ui.ts` | The **NLE editor** (HTTP server + vanilla-JS draggable timeline). Calls `buildIntroSpec`. |
| `src/assets/…` | Bundled SFX/music/overlays/watermark (below). |
| `VIDEO_INTRO_SPEC.md` | Original agreed spec (some parts now superseded — e.g. text animation is the green-screen plate, captions are implemented). |

---

## 3. Assets (`src/assets/`, resolved by basename, any extension)

Resolution order: `INTRO_ASSETS_DIR` env → `src/assets` → `../assets` → `../src/assets`.
Per-asset override env: `INTRO_FONT_PATH`, `INTRO_BOLD_FONT_PATH`, `BOOM_SFX_PATH`.

```
src/assets/
  sfx/
    camera_click.mp3   # pause + glitch beats
    film_grain.mp3     # rises at the end
    boom.mp3           # final impact (after the grain)
    mouse_click.mp3    # (present, unused)
  music/
    background_track.mp3
  overlays/
    glitch.mp4         # dark-bg glitch, SCREEN-blended (not green screen)
    white_flash.mp4    # full-frame white→black flash, SCREEN-blended (its audio is dropped)
    text_animation.mp4 # GREEN-screen "SUSPECT" lower-third nameplate (chroma-keyed)
  watermark/
    watermark.png      # RGBA disclaimer text on a transparent 1280×720 canvas
  fonts/               # optional; drop a .ttf/.otf here (bold name auto-prefers a *bold* file)
```

Asset specifics the code depends on:
- **Green key** for the name plate is `0x31fe02` (sampled from the asset). New plate art → re-sample and update `GREEN_KEY` in `intro.ts`.
- The name plate **wipes in over ~2s then holds**; the bar's natural centre is `(0.461, 0.537)` and the **pin dot** is at `(0.601, 0.421)` (normalized). These constants live in `buildIntroSpec`.
- `glitch.mp4` / `white_flash.mp4` are **dark-background** clips → screen-blend (black adds nothing, bright pixels add). They do NOT need alpha.
- `watermark.png` is mostly transparent; we **trim it to the text bbox** at render time.

---

## 4. `IntroSpec` (the absolute-timeline model)

Defined in `src/intro.ts`. All times are **absolute seconds on the final output**.

```ts
interface IntroSpec {
  pauseAtSec: number;        // freeze inserted here (in the SOURCE clip)
  freezeDurationSec: number; // F — how long the held frame lasts
  blackSec: number;          // black tail before the main video

  zoom: number;              // ZOOM SPEED now (constant-rate push-in; ~zoom reached per 10s, then keeps going)
  flashSec: number;          // flash clip length (trim), default ~0.6
  glitchAtSec: number;       // legacy single-glitch time
  glitchDurationSec: number; // (informational; glitch plays its clip length)
  glitchOpacity: number;     // legacy single-glitch opacity / default for new glitches
  textStartSec: number;      // when the name plate starts (clamped into the freeze)
  subjectName: string;       // INTRO_SUBJECT_NAME

  textCenterX?: number;      // where the pin DOT points (normalized). Omitted = asset's spot.
  textCenterY?: number;      //   bar + name hang down-left of the dot.

  audio: IntroAudioClip[];   // voiceover|music|grain|boom|click, each {start, duration?, volume, fadeInSec?}

  // visual-effect toggles (default ON). Editor add/remove.
  hasFlash?: boolean; hasGlitch?: boolean; hasText?: boolean; hasWatermark?: boolean;

  // MULTI-INSTANCE (NLE): when present these WIN over the single fields above.
  flashes?: { atSec: number }[];
  glitches?: { atSec: number; opacity: number }[];
}
```

`buildIntroSpec(introVideo, voiceoverPath|null, spec, outPath, captionsSrtPath|null)`.

---

## 5. Render pipeline (ffmpeg passes, in order)

Each beat is a labelled pass into a temp dir (so a failure points at one stage):

1. **seg1** — clip `[0, T]`, normalized to W×H/fps.
2. **freeze** — the held frame, composited (see §6). Video-only (`-an`); a silent track is added so concat stays uniform.
3. **seg2** — clip `[T, end]`.
4. **black** — `blackSec` of black + silence.
5. **base concat** — seg1 + freeze + seg2 + black (video + the clip's own audio in seg1/seg2, silence elsewhere).
6. **audio mix** — every `IntroAudioClip` `adelay`'d to its absolute start and `amix`'d over the base (`music` uses `-stream_loop -1`).
7. **watermark overlay** — trimmed disclaimer PNG, bottom-left, whole duration (§6).
8. **captions** — SRT shifted to the voiceover's absolute start, burned with `subtitles` (§6).

### 6. The freeze pass — compositing order (the important one)

All blending happens in **planar RGB (`gbrp`)** until the very end, then one convert to
`yuv420p`. **Blending the white flash in YUV tints the frame pink** — that's why flash +
glitch screen-blend in gbrp.

```
[0:v] one frame → supersample scale (2–4×) → zoompan (constant-rate zoom) → rgb24
      → [optional synthetic flash fade if no flash clip] → gbrp           [bg]
  for each flash:  white_flash → gbrp, delayed to its time, black-padded → screen-blend
  for each glitch: glitch → gbrp, delayed to its time, black-padded       → screen-blend (opacity)
      → yuv420p                                                            [byuv]
  name plate (if on): text_animation → chromakey(0x31fe02) → yuva420p, held,
      shifted so the wipe STARTS at textStart → overlay at the dot offset  [ov]
  name letters (if on): drawtext (black, centred in the bar, fades in after the wipe)
      → yuv420p [v]
```

Key implementation notes (each fixed a real bug — don't regress):
- **Zoom = supersample + `zoompan` from ONE frame.** zoompan crops an *integer* window each
  frame → it jitters on a 1080p source. Fix: upscale the still 2–4× (`zUp`), let zoompan
  generate the whole move from a single frame (`d=fzFrames`), downscale to W×H (anti-aliases).
  Rate is **constant** (`zRate` per frame, refs `ZOOM_REF_SEC=10`) so it keeps creeping in
  the whole freeze instead of ramping to a target and settling. Costs render time (~tens of
  seconds for a long freeze) — lower `zUp` if it's too slow.
- **Flash = your clip, screen-blended**, padded with black after `flashSec` so it flashes
  once. Synthetic `fade=…:color=white` is a **fallback only if `white_flash.*` is missing**.
- **Glitch** is dark-bg → screen-blend (`all_mode=screen`), `all_opacity` per instance.
- **Name plate** is chroma-keyed (`chromakey=0x31fe02:0.30:0.04` — tight blend = fully opaque
  bar). It's **anchored on the pin dot**: `textCenterX/Y` move the whole plate so the dot lands
  on the subject; the bar+name hang **down-left** of the dot (so a long name + far-left dot can
  clip the frame edge — nudge the dot right). Name is **drawtext** (needs libfreetype): black,
  centred in the bar, auto-shrunk to fit, fades in ~1s after the wipe.
- **Multi-instance:** `spec.flashes[]` / `spec.glitches[]` win over the single fields; the
  engine loops and screen-blends each. The name plate is intentionally single.
- **Watermark:** the PNG is sparse text on a transparent canvas → `cropdetect` finds nothing,
  so we **scan the alpha plane in Node** (`trimTransparent`) to find the text bbox, crop to it,
  then scale to ~34% width and pin bottom-left. (Looks faint by design — it's a gray disclaimer.)

---

## 7. ffmpeg requirements ⚠️

The compositor needs a **full ffmpeg build** with **`drawtext` (libfreetype)**, **`chromakey`**,
**`subtitles` (libass)**, `zoompan`, `tpad`, `blend`. Homebrew's minimal ffmpeg lacks
`drawtext`/`libass` → the name letters and captions silently skip (a black-box/no-text fallback,
not the pink tint — that was a separate YUV-blend bug, now fixed).

Point the binaries at a full build (e.g. an evermeet/static ffmpeg):
```
FFMPEG_BIN=~/Downloads/ffmpeg   FFPROBE_BIN=~/Downloads/ffprobe
```
The droplet must also have a full build. Other env: `INTRO_ASSETS_DIR`, `INTRO_FONT_PATH`,
`INTRO_BOLD_FONT_PATH`, `BOOM_SFX_PATH`.

---

## 8. The test editor (`scripts/test-video-ui.ts`)

A small HTTP server + a vanilla-JS **NLE timeline** to tune the look and save presets. It is
the only caller of `buildIntroSpec` today.

```bash
FFMPEG_BIN=~/Downloads/ffmpeg FFPROBE_BIN=~/Downloads/ffprobe \
  pnpm --filter @slate/watcher test-video-ui
# open the printed http://HOST:PORT  (VIDEO_TEST_HOST/VIDEO_TEST_PORT env-overridable)
```

The editor server itself lives in `src/introEditor.ts` (exported `startIntroEditor()`);
`scripts/test-video-ui.ts` is just a local launcher.

**Runs in-process with the watcher (production):** set `INTRO_EDITOR=true` in the
watcher's env (optional `INTRO_EDITOR_PORT`, default 5174; binds `0.0.0.0`) and it
boots alongside the watcher on the droplet — the ffmpeg box — so there's nothing
separate to build or run. It can't run on Vercel (no ffmpeg), which is why it lives here.

**Dashboard tab (proxied embed):** set `NEXT_PUBLIC_INTRO_EDITOR_URL` to the editor's
origin (e.g. `http://<droplet-ip>:5174`). The dashboard then (a) shows an **Intro Editor**
nav tab, and (b) **proxies** the editor under its own origin via a `next.config` rewrite
(`/editor-app/:path* → ${NEXT_PUBLIC_INTRO_EDITOR_URL}/:path*`); `/editor` iframes
`/editor-app/`. So the browser stays same-origin/https and the editor host needs **no https/cert**
(plain http is fine — Vercel forwards server-side). The editor's client fetches are relative so
they resolve under `/editor-app/`. Rebuild the dashboard after setting the env.

Caveats of proxying through Vercel: large uploads (intro clip) may hit Vercel's request-body
limit and long renders may hit its proxy response timeout. If you hit either, expose the editor
directly over https (Caddy/tunnel) and point the iframe at that URL instead. Also note the editor
has no auth — opening its port publicly exposes it; restrict by firewall or add a token guard.

Use: upload an intro clip (+ optional voiceover + optional SRT) → drag the FREEZE/BLACK blocks,
flash/glitch/name markers, and audio clips → set props (Subject name, Zoom speed, Flash s,
Glitch opacity, **Dot X/Dot Y**, Watermark) → **Render** → preview.

- **Add effect** buttons: flash & glitch are **multi-instance** (each adds a new draggable
  marker); the name plate is single.
- **Endpoints:** `/probe` (ffprobe), `/render` (→ `buildIntroSpec`), `/upload` (SRT), `/presets` (GET/POST/DELETE).
- **Captions:** uploaded SRT wins; else, with "Auto-captions" on and `OPENAI_API_KEY` set, it
  transcribes the voiceover via the **OpenAI Whisper API** (`whisper-1`, override `OPENAI_STT_MODEL`).
  No key → captions skipped (no crash). NOTE: ideal source is the voiceover *script* (you already
  have the words) or ElevenLabs timestamps — STT is the hands-off fallback.
- **Presets** (per-channel, saved server-side): store the relative effect layout + the **exact
  audio layout** (so a clip dragged to the middle stays there on re-apply) + name position.

⚠️ **Editor JS constraint:** the HTML page is a JS **template literal** (`const PAGE = \`…\``),
so the embedded client script must **avoid backticks and `${…}`** or it breaks the page.

---

## 9. Per-card inputs (production intent)

- **Intro clip** = card's first video attachment (`trello.firstVideoAttachment`).
- **Voiceover** = card's first audio attachment *(selection not wired in the watcher yet)*.
- **`EFFECT_PAUSING_TIMESTAMP`** = the pause point (`effects.ts`, already parsed).
- **`INTRO_SUBJECT_NAME`** = name-plate text *(parsing not wired yet)*.
- Style/timing = the **channel's saved preset** *(presets live in the editor's store, not yet
  in Supabase per channel)*.

---

## 10. ⚠️ Production wiring — NOT done

The new compositor is **editor-only**. `src/pipeline.ts` (video mode) still calls the OLD
first-cut path: `applyFreezeFlashBoom` + `prependIntro` from `src/video.ts`. To ship the new
intro to real episodes, the remaining work is:

1. **Watcher** (`watcher.ts`): also grab the **voiceover audio attachment** and parse
   **`INTRO_SUBJECT_NAME`** (today only the intro video + `EFFECT_PAUSING_TIMESTAMP` are wired).
2. **Per-channel preset storage**: move presets from the editor's local store into **Supabase**
   so the watcher can load a channel's look.
3. **Pipeline finalize**: replace `applyFreezeFlashBoom`/`prependIntro` with
   **`buildIntroSpec(intro, voiceover, channelPreset+cardInputs, out, captionsSrt)`**, then
   concat **intro + main**, and upload **only the final video** when video mode is on.
4. **Captions source for automation**: card-provided SRT/script text, or auto-STT on the
   voiceover (needs `OPENAI_API_KEY`).
5. **Full ffmpeg on the droplet** (drawtext/chromakey/libass) — see §7.

Until then, deploying does **not** change production behavior for video-mode channels (they
keep the old first-cut effect).

---

## 11. Defaults / tuning quick-ref

| Knob | Default | Notes |
|---|---|---|
| Zoom (speed) | 1.2 | constant-rate push-in; higher = faster creep |
| Flash length | ~0.6s | trims `white_flash.mp4` |
| Name wipe → letters | +1.0s | letters fade in after the bar wipes |
| Dot X / Dot Y | 0.5 / 0.4 | where the pin dot points (put it on the subject) |
| Green key | `0x31fe02` | re-sample if the plate art changes |
| Supersample (`zUp`) | 2–4× | auto by resolution; lower if zoom render is slow |
| Watermark width | ~34% of W | bottom-left, full intro |
| Caption style | white, bold, black outline, bottom-centre | `CAPTION_STYLE` in `intro.ts` |
