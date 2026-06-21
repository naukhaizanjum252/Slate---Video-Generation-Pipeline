/**
 * Local launcher for the intro editor. The editor itself now lives in
 * src/introEditor.ts (so it can also run inside the watcher daemon in production).
 * This just boots it standalone for local tuning:
 *
 *   pnpm --filter @slate/watcher test-video-ui   →   http://127.0.0.1:5174
 *
 * Needs ffmpeg + ffprobe on PATH (override with FFMPEG_BIN / FFPROBE_BIN).
 * Host/port via VIDEO_TEST_HOST / VIDEO_TEST_PORT.
 */
import './loadEnv'; // MUST be first — loads apps/watcher/.env before other imports
import { startIntroEditor } from '../src/introEditor';

startIntroEditor();
