// Side-effect import: load apps/watcher/.env BEFORE anything reads process.env
// (e.g. video.ts reads FFMPEG_BIN at import time). Must be the first import in the
// standalone editor launcher. Harmless if the vars are already set in the shell.
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
