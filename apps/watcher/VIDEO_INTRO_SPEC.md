# Video-mode intro compositor — spec & asset checklist

> ℹ️ This is the **original agreed spec**. For what the code actually does now
> (the `buildIntroSpec` compositor, every knob/asset, the test editor, and the
> pending production wiring), see **[`INTRO_COMPOSITOR.md`](./INTRO_COMPOSITOR.md)** —
> that's the source of truth; some items below are superseded.

This is the agreed spec for the per-channel **video mode** intro edit. The
watcher edits the **intro clip**, then concatenates the **main episode video**
after it (with a black-screen transition). The main video is NOT edited.

Status: **spec locked, waiting on the assets folder + a sample intro/voiceover
to build & tune** (we'll iterate via the `test-video-ui` tool).

---

## Per-card inputs

**Attachments on the Trello card:**
- Reference image → studio generation (existing)
- **Intro video** clip (first video attachment)
- **Voiceover** audio (first audio attachment) — its length sets how long the
  freeze holds *(client hasn't finalized delivery; assumed an attachment for now)*

**Description keys:**
- `EFFECT_PAUSING_TIMESTAMP=00:03` — where in the intro the pause/effect happens
- `INTRO_SUBJECT_NAME=...` — shown in the text animation

---

## Intro edit timeline (example pause at 00:03)

1. **0 → 3s** — intro plays normally.
2. **At 3s (pause point):** freeze frame · **camera-click SFX** · **white flash** ·
   **slight zoom-in** (zoom held).
3. **~2s of entrance effects**, then the frozen+zoomed frame shows:
   - **intro voiceover** (foreground, louder)
   - **background music** (quieter) — *only* under the voiceover
   - **subject-name text animation** (`INTRO_SUBJECT_NAME`)
   - **captions** of the voiceover, centered *(deferred — no SRT yet)*
4. **When the voiceover ends (~3–5s):** **camera-glitch overlay + click SFX** ·
   **reset zoom** · **unfreeze** → intro resumes from the 3s frame.
5. **Intro plays on** until ~2s before its end.
6. **Last 2s of the intro:** **film-grain audio** ramps up until it overpowers the
   video audio · **boom** at the very end.
7. **Black screen (~2s)** as the transition.
8. **Main episode video** concatenated after.

Freeze duration ≈ entrance-effects time + voiceover length.

---

## What ffmpeg generates vs. what the assets folder must provide

**Generated in ffmpeg (no asset):** pause/freeze + unfreeze, white flash, zoom
in/reset, all volume automation (VO loud / music quiet / film-grain rising),
black screen, subject-name text + captions, all stitching.

**Provided assets** (proposed location `apps/watcher/src/assets/`, override paths via env):
```
assets/
  sfx/
    camera_click.wav     # used for BOTH the pause and the glitch
    film_grain.wav       # rises at the end
    boom.wav             # end of clip
  music/
    background_track.mp3 # one bed for all episodes
  overlays/
    glitch.mov           # glitch effect, WITH alpha (.mov ProRes 4444 / .webm)
  fonts/
    intro.ttf            # subject name + captions
```

---

## Open items

- **Text animation:** (a) generate in ffmpeg (default, dynamic, no asset), or
  (b) CapCut graphic exported over green screen → chroma-key + draw name on top.
  Decide the *motion* style for (a).
- **Captions:** need an `.srt`/transcript or speech-to-text; deferred for now.
- **Voiceover delivery:** confirm it's a card audio attachment (client TBD).
- Tuning knobs (freeze/flash length, zoom amount, ramp curves) to be set against
  a real clip via `pnpm --filter @slate/watcher test-video-ui`.
