import { Writable } from 'node:stream';

/**
 * stdout carries JSON-RPC only (NF-09). Returns the one writer for the MCP transport; after this every other
 * process.stdout.write and the console methods that print to stdout go to stderr.
 */
export const reserveStdout = (): Writable => {
  const raw = process.stdout.write.bind(process.stdout) as (chunk: unknown, cb?: (err?: Error | null) => void) => boolean;
  const wire = new Writable({
    write(chunk, _enc, cb) {
      raw(chunk, cb);
    },
  });
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  for (const m of ['log', 'info', 'debug', 'table', 'dir', 'dirxml', 'count', 'timeLog', 'group', 'groupCollapsed'] as const) {
    (console as unknown as Record<string, unknown>)[m] = console.error;
  }
  return wire;
};
