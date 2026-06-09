import ws from 'ws';
import { createLogger } from './logger';
import { startWatcher } from './watcher';

// Node < 22 has no global WebSocket, but @supabase/realtime-js requires one at
// client creation (even though we never use realtime). Polyfill it before any
// Supabase client is constructed so the watcher runs on Node 20+.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = ws;
}

const log = createLogger('main');

// Last-resort guards so a stray rejection or exception never kills the daemon.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', reason);
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err);
});

try {
  startWatcher();
} catch (err) {
  log.error('Fatal startup error', err);
  process.exit(1);
}
