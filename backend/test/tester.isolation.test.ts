import { describe, expect, test } from 'bun:test';
import { createQueue, forEachVault, perVaultGuard } from '../src/tester/runner.ts';
import type { Logger } from '../src/utils/logger.ts';

// ADR-4 (v2/37): one tester process serves every vault, so nothing one vault does may stop another.
const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ctx = (shop: string) => ({ shop });

describe('per-vault isolation', () => {
  test('a throwing vault is reported and the others still run', async () => {
    const ran: string[] = [];
    const failed: string[] = [];
    const job = perVaultGuard(quiet, async (c: { shop: string }) => void failed.push(c.shop), async (c: { shop: string }) => {
      if (c.shop === 'b') throw new Error('rpc down');
      ran.push(c.shop);
    });
    await forEachVault(async () => ['a', 'b', 'c', 'd'].map(ctx), job, quiet)();
    expect(ran.sort()).toEqual(['a', 'c', 'd']);
    expect(failed).toEqual(['b']);
  });

  test('a slow vault skips only its own next run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runs: string[] = [];
    const job = perVaultGuard(quiet, async () => {}, async (c: { shop: string }) => {
      runs.push(c.shop);
      if (c.shop === 'slow') await gate;
    });
    const first = forEachVault(async () => [ctx('slow'), ctx('fast')], job, quiet)();
    await Bun.sleep(5);
    await forEachVault(async () => [ctx('slow'), ctx('fast')], job, quiet)(); // second tick while slow is still running
    release();
    await first;
    expect(runs.filter((s) => s === 'fast')).toHaveLength(2);
    expect(runs.filter((s) => s === 'slow')).toHaveLength(1);
  });

  test('at most `concurrency` vaults run at once, and a failed context load runs nothing', async () => {
    let live = 0;
    let peak = 0;
    const job = async () => {
      peak = Math.max(peak, ++live);
      await Bun.sleep(5);
      live--;
    };
    await forEachVault(async () => Array.from({ length: 8 }, (_, i) => ctx(`v${i}`)), job, quiet, 3)();
    expect(peak).toBe(3);
    let called = false;
    await forEachVault(async () => Promise.reject(new Error('db down')), async () => void (called = true), quiet)();
    expect(called).toBe(false);
  });

  test('the commit queue runs one job at a time, never queues a shop twice, and survives a failure', async () => {
    const q = createQueue(quiet);
    const order: string[] = [];
    let live = 0;
    const run = (shop: string, fail = false) => async () => {
      expect(++live).toBe(1);
      await Bun.sleep(3);
      order.push(shop);
      live--;
      if (fail) throw new Error('generation failed');
    };
    q('a', run('a', true));
    q('b', run('b'));
    q('b', run('b')); // already queued: dropped
    await q('c', run('c'));
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
