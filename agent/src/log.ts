// One JSON object per line.
type Fields = Record<string, unknown>;
const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
let stderrOnly = false;
// stdio MCP servers own stdout for JSON-RPC; every log line must go to stderr there
export const logToStderr = (): void => {
  stderrOnly = true;
};
const emit = (level: string, msg: string, fields?: Fields): void => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), component: 'agent', msg, ...fields }, replacer);
  (stderrOnly || level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
};

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);
