# Body Video Spec — derived from the reference clip

This documents the **main video body** (everything after the edited intro) so we can
build it on our end with ffmpeg instead of the studio's `/cb_build_video`. It is based
on a frame-by-frame analysis of the reference clip the user supplied
(`Screen Recording 2026-06-22 at 11.14.24 PM.mov`).

> ⚠️ The reference clip is a **different episode** than the "Sgt. Van Dyke" script PDF.
> The clip's subject is a USPS mail-carrier bodycam case. Where something might be
> specific to this clip vs. a general rule, it's flagged under **NEEDS CONFIRMATION**.

## Source clip (for reference only)
- Screen recording: **2520×1412, 120 fps, ~118.75 s**, AAC stereo 48 kHz.
- It's a full-screen playback capture, so the video content fills the frame (16:9).
- Frames were extracted to `/tmp/refclip/` for analysis (not committed).

## Overall structure observed
| Time | Section | What's on screen |
|------|---------|------------------|
| 0:00 – ~0:28 | **Intro** | Edited intro (our compositor); in this ref it's raw bodycam with captions. |
| ~0:28 – 1:39 | **First body image** | The **enhanced reference image** (step-1 `/cb_pipeline_enhance` output), held, slow oscillating zoom, grain overlay, captions. (In this clip the enhanced ref resembles the intro subject, which is why it looked like a freeze.) |
| ~1:31 – 1:39 | **CTA** (over current image) | Animated **like / subscribe** graphic overlaid; image does **not** change. |
| ~1:39 (~0.8–1 s) | **Transition** | **Dip to black** (fade out → fade in); grain dust still visible on the black. |
| 1:39 – end | **AI images (prompt 1…N)** | AI **"physical photo artifact"** images, centered with blurred/darkened fill, warm light-leak, slow oscillating zoom, grain overlay, captions. |

## Element specs (observed)

### Captions
- White text, **semi-bold**, **thin** dark outline (matches our reduced `Outline≈1.4`).
- **Centered**, near the bottom (~12–15% up from the bottom edge).
- Present over the intro, the freeze, and the body images — i.e. the whole runtime.
- Short phrases (a few words per cue) — consistent with SRT-cue-length lines.

### Overlay (the "overlay" the user referred to)
A continuous **film-grain / old-film overlay**, screen-blended on top of everything:
- Fine moving grain + **dust specks**.
- Occasional **vertical scratch lines** (e.g. left third).
- Faint **circular swirl / lens artifact** drifting across.
- A warm **orange light-leak**, strongest near the **top-center**.
- The overlay is visible **even during the dip-to-black transition** (so it's composited
  globally, above the image layer, for the full body — not per-image).

### Zoom (Ken Burns) — CONFIRMED
- **Oscillating** slow zoom: the image gently **breathes** — very slow zoom-in, then
  zoom-out, then in again — rather than a single-direction push. Centered.
- Amount is small/subtle. Implement as a slow sinusoidal scale (e.g. zoom oscillating
  ~1.0 → ~1.08 → 1.0 over a multi-second period), supersampled for smoothness.

### Image presentation (AI photos)
- The AI image is a **physical-photo artifact** (baked-in glossy photo border, vintage
  family-album look — exactly the script's "Physical Photo Artifact / Standard Kodak").
- The photo is **centered at its native aspect** (~4:3), NOT stretched to 16:9.
- The **16:9 frame is filled** behind it by a **blurred + darkened copy** of the same image.
- Warm light-leak + grain sit on top.

### Transitions between images — CONFIRMED
- **Always a dip to black**: current image fades out to (near) black, next fades in.
- Total ~**0.8–1.0 s**. Grain persists across the black.

### CTA treatment — CONFIRMED
- During CTA narration, an animated **like/subscribe graphic** appears, centered.
- The underlying **image does not change** for the CTA.
- It's triggered at **each `[CTA — …]` marker** in the script.
- The graphic will be supplied as an **overlay video** (user-provided) — composite it
  over the current image for the CTA's duration (likely chroma-key or alpha; TBD on the
  file). Drop it in `apps/watcher/src/assets/overlays/`.

## Body image sequence — CONFIRMED
The body **always opens on the enhanced reference image** (the output of step 1,
`/cb_pipeline_enhance`), held over the opening narration (hook + first CTA), then
transitions through the AI images in order:

```
[enhanced reference image]  →  IMAGE PROMPT 1  →  IMAGE PROMPT 2  →  …  →  IMAGE PROMPT N
```

So the body has **N+1** stills. The enhanced ref covers from body-start until
`IMAGE PROMPT 1`'s aligned timestamp; each AI image then runs over its own narration
window. (In the reference clip the enhanced ref happened to resemble the intro subject,
which is why it read like a continued freeze.)

We must therefore locate the **enhanced reference image** in the generated bundle
(filename/path TBD — confirm when we inspect a real output folder).

## Generated bundle layout — CONFIRMED (from a real Drive folder)
```
audio/full.mp3            full voiceover — 2015 s (~33.6 min)
episode_package.json      structured source of truth (see fields below)
image_prompts.txt         the 16 prompts, human-readable
images_2/01_*.png … 16_*  ← the 16 ordered AI images (USE THIS set)
images/…                  partial/older subset (7 files, mixed numbering) — ignore
reference_enhanced.png    ← the enhanced reference image (body's FIRST still)
script_full.docx          rendered script (we DON'T need it — use the JSON)
youtube_metadata.txt
```
`episode_package.json` fields we use:
- `script_full_markdown` — full script with inline `[IMAGE PROMPT N: …]`, `## Beat`,
  `### [CTA — …]`, and the intro block. **Source for image positions.**
- `script_narration` — pure spoken text (for SRT alignment / proportional timing).
- `image_prompts` (16) — map 1:1 to `images_2/NN_*`.
- `intro_line` — intro VO (the NAME TAG quote, ~9 s spoken; first block of the narration).
- `cta_after_hook`, `cta_mid` — CTA narration (mark where the subscribe overlay plays).
- `subject_name`, `titles`, `description`, `end_card`.

## Timing model — VALIDATED against real data
Parsing rules (proven on the real package):
1. Split the intro block (everything before `## Beat 1`) from the body. Intro VO = `intro_line`.
2. In the body markdown, narration = prose with `[…]` brackets and `##/###` headers removed.
   CTA paragraphs ARE narration (spoken).
3. Each `[IMAGE PROMPT N:]` marker's cumulative narration offset = where image N enters.
4. `reference_enhanced.png` holds from body-start → image-1's offset (~103 s here);
   image N holds from its offset → N+1's; image 16 → end.
5. Duration = narration-char span ÷ total body chars × body-VO duration.
   Swap in the SRT later for exact cut points (no rework).

Validated output: 16 images, durations ~77–165 s (avg ~125 s), body ≈ 2007 s. ✅

## Build model (target implementation)
1. **Intro** — produced by our existing compositor (`intro.ts`).
2. **Body** — stills in order: `[enhanced reference image]` then each `[IMAGE PROMPT N]`:
   - Determine each still's on-screen window from the **SRT ↔ script alignment** (marker
     position → spoken timestamp → start/end). The enhanced ref spans body-start →
     IMAGE PROMPT 1's timestamp. Stand-in until SRT exists: proportional by narration
     text length × total VO duration.
   - Render a clip: blurred/darkened 16:9 fill + sharp centered image + **oscillating**
     slow zoom (supersampled, like the intro) for that duration.
   - Join with a **dip-to-black** between every still.
3. **Global layers over the whole body**: film-grain/light-leak **overlay** video (screen,
   user-provided) + **captions** (libass from the SRT) + the **CTA subscribe** overlay
   video at each `[CTA]` window.
4. **Concatenate** intro + body → one final MP4; voiceover MP3 is the audio bed.

Reuses existing building blocks: `zoompan` supersampling, screen-blend overlays,
`subtitles`/libass, and concat — all already in `intro.ts` / `video.ts`.

## Resolved
1. Body opens on the **enhanced reference image** (step-1 output), then AI images 1…N. ✅
2. Zoom **oscillates** (slow in/out breathing), centered. ✅
3. Transitions: **always dip-to-black** (~0.8–1 s). ✅
4. CTA: animated like/subscribe **overlay video** (user-provided), at each `[CTA]` marker. ✅
5. Grain/light-leak **overlay video**: user has it / will provide. ✅

## Assets received
- **`overlays/film_grain.mp4`** — 1920×1080, 30 fps, no alpha (yuv420p), 156 s, has an
  (unused) audio track. White dust/grain on black + slight vignette → **screen-blend**
  (black drops out), **loop** to cover the body length, **mute** audio. Same handling as
  `white_flash.mp4` / `glitch.mp4`. (Warm light-leak not obvious in samples — may be
  elsewhere in the file or baked into images; revisit if needed.)

## Still pending (assets + data)
- **Subscribe/CTA overlay video** (user adding soon) → `apps/watcher/src/assets/overlays/`.
  Need to know if it's chroma-keyed or has alpha.
- **SRT** for the full voiceover (for exact image/caption timing). Until then: text-length
  proportional stand-in (validated above).
- Watermark on the body? (none seen in this clip; intro has one.) — assume **no** unless told.
- Output target: **1080p 16:9** assumed.
