import { errFields, type Logger } from '../utils/logger.ts';

// ADR-4 (v2/37): one tester process for every vault. Config-free so the isolation test needs no env.

export interface ShopScoped {
  shop: string;
}

/**
 * Wraps a job so each vault has its own guard: a slow vault skips only its own next run, never another's.
 * A throw is logged with the shop and reported to `onError`; it never reaches the caller.
 */
export const perVaultGuard = <C extends ShopScoped, A extends unknown[]>(
  log: Logger,
  onError: (ctx: C) => Promise<void>,
  fn: (ctx: C, ...args: A) => Promise<void>
) => {
  const running = new Set<string>();
  return async (ctx: C, ...args: A): Promise<void> => {
    if (running.has(ctx.shop)) return log.debug('previous run still active, skipping', { shop: ctx.shop });
    running.add(ctx.shop);
    try {
      await fn(ctx, ...args);
    } catch (error) {
      log.error('run failed', { shop: ctx.shop, ...errFields(error) });
      await onError(ctx).catch(() => undefined);
    } finally {
      running.delete(ctx.shop);
    }
  };
};

/** Runs `job` for every context, at most `concurrency` at once. Errors stay inside their vault. */
export const forEachVault =
  <C extends ShopScoped>(contexts: () => Promise<C[]>, job: (ctx: C) => Promise<void>, log: Logger, concurrency = 3) =>
  async (): Promise<void> => {
    let list: C[];
    try {
      list = await contexts();
    } catch (error) {
      return log.error('loading vault contexts failed', errFields(error));
    }
    let next = 0;
    const lane = async () => {
      while (next < list.length) {
        const ctx = list[next++];
        try {
          await job(ctx);
        } catch (error) {
          log.error('vault job failed', { shop: ctx.shop, ...errFields(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, lane));
  };

/** One job at a time across vaults (commits: generation shares one NEAR AI key); a shop already queued is not queued twice. */
export const createQueue = (log: Logger) => {
  let tail: Promise<void> = Promise.resolve();
  const queued = new Set<string>();
  return (shop: string, run: () => Promise<void>): Promise<void> => {
    if (queued.has(shop)) {
      log.debug('already queued', { shop });
      return tail;
    }
    queued.add(shop);
    tail = tail
      .then(run)
      .catch((error) => log.error('queued job failed', { shop, ...errFields(error) }))
      .finally(() => queued.delete(shop));
    return tail;
  };
};
