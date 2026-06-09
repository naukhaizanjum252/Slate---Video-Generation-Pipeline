import { createLogger } from './logger';
import { startWatcher } from './watcher';

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
