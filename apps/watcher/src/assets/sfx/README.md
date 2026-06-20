# SFX assets

Drop the boom sound effect here as **`boom.wav`**:

```
apps/watcher/src/assets/sfx/boom.wav
```

It's used by video-mode episodes for the freeze + flash + **boom** effect at the
card's `EFFECT_PAUSING_TIMESTAMP`. WAV (PCM, 48 kHz stereo) preferred; trim it to
just the effect (no long silence).

- Override the path with the `BOOM_SFX_PATH` env var if you keep it elsewhere.
- The file is resolved at runtime from this folder for both `ts-node` (dev) and
  the compiled `dist/` build (see `resolveBoomSfx()` in `src/video.ts`).
- If it's missing, video-mode episodes with an effect timestamp will fail with a
  clear "Boom SFX not found" error.
