/**
 * Tiny structured logger. Keeps stdout readable in PM2 logs while
 * attaching a consistent prefix + ISO timestamp to every line.
 */
type Level = 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}`;
  const stream = level === 'error' ? console.error : console.log;
  if (extra !== undefined) {
    stream(base, typeof extra === 'string' ? extra : safeStringify(extra));
  } else {
    stream(base);
  }
}

function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) {
      return value.stack ?? `${value.name}: ${value.message}`;
    }
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string) {
  return {
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
