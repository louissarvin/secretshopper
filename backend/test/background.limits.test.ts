import { afterAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createRateGate } from '../src/lib/near/rateGate.ts';
import { isRateLimited, RateLimitedError, retryAfterMs } from '../src/lib/near/rateLimit.ts';
import { afterVisit, backoffMs, BACKOFF_MAX_MS, emptyState, IDLE_EVERY_MS, isIdle, pickDue, type SchedVault, type VaultSchedState } from '../src/lib/indexerSchedule.ts';

// 2026-11-13: the per-vault indexer exhausted FastNEAR's rate limit and user requests failed. These pin the fix.

describe('background rate gate', () => {
  test('never more than perMinute grants in a sliding minute; waits instead of failing', async () => {
    let t = 0;
    const slept: number[] = [];
    const gate = createRateGate({ perMinute: 3, concurrency: 5, now: () => t, sleep: async (ms) => (slept.push(ms), void (t += ms)) });
    const at: number[] = [];
    for (let i = 0; i < 7; i++) await gate.run(async () => at.push(t));
    expect(at).toEqual([0, 0, 0, 60_000, 60_000, 60_000, 120_000]);
    expect(slept).toEqual([60_000, 60_000]);
  });

  test('concurrency caps calls in flight', async () => {
    const gate = createRateGate({ perMinute: 100, concurrency: 2 });
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run(async () => {
          peak = Math.max(peak, ++inFlight);
          await Bun.sleep(5);
          inFlight--;
        })
      )
    );
    expect(peak).toBe(2);
  });

  test('a failing call releases its slot', async () => {
    const gate = createRateGate({ perMinute: 100, concurrency: 1 });
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await gate.run(async () => 'next')).toBe('next');
  });
});

describe('rate limit detection', () => {
  test('429s, exhausted failover lists and our typed error are rate limits; other errors are not', () => {
    for (const e of [
      new RateLimitedError('FastNEAR tx API /v0/account failed: 429', 5000),
      new Error('Exceeded 2 providers'),
      Object.assign(new Error('Exceeded 3 providers. See the provider errors'), { name: 'FailoverRpcError' }),
      new Error('-429 Rate limits exceeded'),
      new Error('Too Many Requests'),
    ])
      expect(isRateLimited(e)).toBe(true);
    for (const e of [new Error('Account x does not exist'), new Error('FastNEAR tx API /v0/account failed: 502'), new Error('timeout'), 'x']) expect(isRateLimited(e)).toBe(false);
  });

  test('Retry-After in seconds or as an HTTP date', () => {
    expect(retryAfterMs('7')).toBe(7000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
    expect(retryAfterMs(new Date(1_000_000 + 4000).toUTCString(), 1_000_000)).toBe(4000);
  });
});

describe('indexer schedule', () => {
  const NOW = 10_000_000_000;
  const def: SchedVault = { shop: 'shop4.testnet', isDefault: true, testerEnabled: true, lastEventAtMs: NOW - 60_000 };
  const busy: SchedVault = { shop: 'busy.testnet', isDefault: false, testerEnabled: true, lastEventAtMs: NOW - 60_000 };
  const legacy2: SchedVault = { shop: 'shop2.testnet', isDefault: false, testerEnabled: false, lastEventAtMs: NOW - 5 * 86_400_000 };
  const legacy3: SchedVault = { shop: 'shop3.testnet', isDefault: false, testerEnabled: false, lastEventAtMs: null };
  const vaults = [def, busy, legacy2, legacy3];
  const opts = (rr = 0) => ({ otherEveryTicks: 4, maxOthers: 4, rr });
  const shops = (r: { due: SchedVault[] }) => r.due.map((v) => v.shop);

  test('backoff doubles from 30 s, caps at 10 min, and never undercuts Retry-After', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((f) => backoffMs(f))).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    expect(backoffMs(1, 90_000)).toBe(90_000);
    expect(backoffMs(1, 3_600_000)).toBe(BACKOFF_MAX_MS);
  });

  test('idle means non-default, untested and no event for a day', () => {
    expect([def, busy, legacy2, legacy3].map((v) => isIdle(v, NOW))).toEqual([false, false, true, true]);
  });

  test('the default vault every tick; others only every 4th tick; idle ones at most hourly', () => {
    const states = new Map<string, VaultSchedState>();
    expect(shops(pickDue(vaults, states, 1, NOW, opts()))).toEqual(['shop4.testnet']);
    expect(shops(pickDue(vaults, states, 2, NOW, opts()))).toEqual(['shop4.testnet']);
    expect(shops(pickDue(vaults, states, 4, NOW, opts()))).toEqual(['shop4.testnet', 'busy.testnet', 'shop2.testnet', 'shop3.testnet']);
    // visited a minute ago: the idle legacy vaults wait for the hour, the tested vault does not
    for (const v of [busy, legacy2, legacy3]) states.set(v.shop, { ...emptyState(), lastVisitAt: NOW - 60_000 });
    expect(shops(pickDue(vaults, states, 8, NOW, opts()))).toEqual(['shop4.testnet', 'busy.testnet']);
    expect(shops(pickDue(vaults, states, 8, NOW - 60_000 + IDLE_EVERY_MS, opts()))).toEqual(['shop4.testnet', 'busy.testnet', 'shop2.testnet', 'shop3.testnet']);
  });

  test('a vault backing off is skipped until its time, the default vault included', () => {
    const states = new Map<string, VaultSchedState>([
      ['shop4.testnet', { nextAt: NOW + 30_000, failures: 1, lastVisitAt: NOW }],
      ['busy.testnet', { nextAt: NOW + 1, failures: 1, lastVisitAt: NOW }],
    ]);
    expect(shops(pickDue(vaults, states, 4, NOW, opts()))).toEqual(['shop2.testnet', 'shop3.testnet']);
    expect(shops(pickDue(vaults, states, 4, NOW + 30_000, opts()))).toEqual(['shop4.testnet', 'busy.testnet', 'shop2.testnet', 'shop3.testnet']);
  });

  test('round robin with a cap of one other vault per visit', () => {
    const states = new Map<string, VaultSchedState>();
    const one = { otherEveryTicks: 1, maxOthers: 1 };
    let rr = 0;
    const seen: string[] = [];
    for (let tick = 1; tick <= 3; tick++) {
      const r = pickDue(vaults, states, tick, NOW, { ...one, rr });
      rr = r.rr;
      seen.push(shops(r)[1]);
    }
    expect(seen).toEqual(['busy.testnet', 'shop2.testnet', 'shop3.testnet']);
  });

  test('after a visit: success clears the backoff; a rate limit doubles it; other errors keep the cadence', () => {
    const s1 = afterVisit(emptyState(), NOW, { ok: false, rateLimited: true, retryAfterMs: null });
    expect(s1).toEqual({ nextAt: NOW + 30_000, failures: 1, lastVisitAt: NOW });
    const s2 = afterVisit(s1, NOW, { ok: false, rateLimited: true, retryAfterMs: 120_000 });
    expect(s2).toEqual({ nextAt: NOW + 120_000, failures: 2, lastVisitAt: NOW });
    expect(afterVisit(s2, NOW, { ok: true })).toEqual({ nextAt: 0, failures: 0, lastVisitAt: NOW });
    expect(afterVisit(emptyState(), NOW, { ok: false, rateLimited: false, retryAfterMs: null })).toEqual({ nextAt: 0, failures: 0, lastVisitAt: NOW });
  });
});

// The tx API client with one attempt (the background indexer's setting): a 429 is thrown at once with Retry-After.
describe('FastNEAR tx API 429 with one attempt', () => {
  let hits = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => (++hits, new Response('slow down', { status: 429, headers: { 'retry-after': '45' } })) });
  afterAll(() => server.stop(true));

  test('RateLimitedError with retryAfterMs 45000, no sleep and no retry', async () => {
    const events = resolve(import.meta.dir, '../src/lib/near/events.ts');
    const script = `const { listContractTxHashes } = await import(${JSON.stringify(events)}); const t = Date.now();
      try { await listContractTxHashes('shop.testnet', 1, 2, 1); console.log('NO_ERROR'); }
      catch (e) { console.log(JSON.stringify({ name: e.name, retryAfterMs: e.retryAfterMs, ms: Date.now() - t })); }`;
    const p = Bun.spawn(['bun', '-e', script], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NEAR_NETWORK: 'testnet', NEAR_TX_API_URL: `http://127.0.0.1:${server.port}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r).toMatchObject({ name: 'RateLimitedError', retryAfterMs: 45_000 });
    expect(r.ms).toBeLessThan(5_000);
    expect(hits).toBe(1);
  }, 15_000);
});
