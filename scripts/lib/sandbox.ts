import type { ChildProcess } from 'node:child_process';

/**
 * near-sandbox's tearDown sends SIGTERM and waits for exit with no limit; a busy nearcore 2.14.0 can ignore it
 * (seen 2026-11-11: a finished pass-rate run hung an hour before writing its results). SIGKILL after a grace period.
 */
export const tearDownSandbox = async (sandbox: { tearDown(): Promise<void> }, graceMs = 20_000): Promise<void> => {
  const child = (sandbox as unknown as { childProcess?: ChildProcess }).childProcess;
  const timer = setTimeout(() => child?.kill('SIGKILL'), graceMs);
  try {
    await sandbox.tearDown();
  } finally {
    clearTimeout(timer);
  }
};
