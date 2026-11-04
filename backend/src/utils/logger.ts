// One JSON object per line; stdout for info/debug, stderr for warn/error.

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = ORDER[(process.env.LOG_LEVEL as Level) || 'info'] ?? ORDER.info;

const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

const emit = (level: Level, component: string, msg: string, fields?: Fields): void => {
  if (ORDER[level] < minLevel) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), component, msg, ...fields }, replacer);
  (ORDER[level] >= ORDER.warn ? process.stderr : process.stdout).write(line + '\n');
};

export interface Logger {
  debug: (msg: string, fields?: Fields) => void;
  info: (msg: string, fields?: Fields) => void;
  warn: (msg: string, fields?: Fields) => void;
  error: (msg: string, fields?: Fields) => void;
}

export const createLogger = (component: string): Logger => ({
  debug: (msg, fields) => emit('debug', component, msg, fields),
  info: (msg, fields) => emit('info', component, msg, fields),
  warn: (msg, fields) => emit('warn', component, msg, fields),
  error: (msg, fields) => emit('error', component, msg, fields),
});

// Server-side only: stacks go to logs, never to API clients.
export const errFields = (e: unknown): Fields =>
  e instanceof Error ? { err: { name: e.name, message: e.message, stack: e.stack } } : { err: String(e) };
