// Background chain work (indexer, health checks) waits here for a slot, so it can never use the provider's whole rate
// limit: request-path reads keep their own headroom. Pure: clock and sleep are injectable for tests.

export interface RateGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Grants used in the current window (for logs and tests). */
  used(): number;
}

export const createRateGate = (o: { perMinute: number; concurrency: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): RateGate => {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const WINDOW = 60_000;
  const grants: number[] = [];
  let active = 0;
  const waiters: (() => void)[] = [];
  const prune = () => {
    const t = now();
    while (grants.length && t - grants[0] >= WINDOW) grants.shift();
  };
  const acquire = async (): Promise<void> => {
    for (;;) {
      if (active >= o.concurrency) {
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      prune();
      if (grants.length < o.perMinute) {
        grants.push(now());
        active++;
        return;
      }
      await sleep(Math.max(WINDOW - (now() - grants[0]), 10));
    }
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        active--;
        waiters.shift()?.();
      }
    },
    used: () => (prune(), grants.length),
  };
};
