import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clockSkew, commitDue, SKEW_WARN_MS } from '../src/tester/chainClock.ts';
import { tlockRoundBounds, tlockRoundFor } from '../src/lib/proof/tlock.ts';

// The contract judges batch_interval and the tlock round by block time. A host clock off by minutes used to pick
// a round the contract refuses on every retry, so commits stopped with only a log line.
const MIN = 60_000;
const HOUR_NS = 3_600_000_000_000n;
const chain = Date.UTC(2026, 10, 13, 9, 0, 0); // chain time of the commit block
const ttlMs = 24 * 60 * MIN;
const graceMs = 90_000;

describe('commit timing follows chain time, whatever the host clock says', () => {
  test('a round picked from the chain head lands in the contract range; one from a skewed host clock does not', () => {
    const headLagMs = 1_500; // head read, sealing, then the tx lands a little later
    const { min, max } = tlockRoundBounds(chain + headLagMs + ttlMs, graceMs);
    const fromChain = tlockRoundFor(chain, ttlMs, graceMs);
    expect(fromChain).toBeGreaterThanOrEqual(min);
    expect(fromChain).toBeLessThanOrEqual(max);
    for (const skew of [-5 * MIN, 5 * MIN]) {
      const fromHost = tlockRoundFor(chain + skew, ttlMs, graceMs);
      expect(fromHost >= min && fromHost <= max).toBe(false);
    }
  });

  test('due is decided by chain time: a fast host clock cannot commit early, a slow one cannot hold commits back', () => {
    const last = (BigInt(chain) * 1_000_000n - 24n * HOUR_NS).toString(); // committed 24 h ago by chain time
    const interval = (24n * HOUR_NS).toString();
    expect(commitDue(last, interval, chain)).toEqual({ due: true, dueNs: BigInt(chain) * 1_000_000n });
    expect(commitDue(last, interval, chain - 1).due).toBe(false);
    expect(commitDue(null, interval, chain)).toEqual({ due: true, dueNs: null });
  });

  test('skew is reported beyond 30 s either way, not for the few seconds final blocks trail', () => {
    expect(clockSkew(chain + 3_000, chain)).toBeNull();
    expect(clockSkew(chain + SKEW_WARN_MS + 1, chain)).toBe(SKEW_WARN_MS + 1);
    expect(clockSkew(chain - 10 * MIN, chain)).toBe(-10 * MIN);
  });

  test('the tester takes due, expiry and round from the chain, not Date.now()', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src/tester/workers.ts'), 'utf8');
    const commit = src.slice(src.indexOf('export const commitBatch = guard'), src.indexOf("const revealLog = createLogger('tester:reveal')"));
    expect(commit).not.toMatch(/tlockRoundFor\(Date\.now\(\)/);
    expect(commit.match(/tlockRoundFor\(await chainHeadMs\(\)/g)).toHaveLength(2);
    expect(commit).toContain('commitDue(');
    expect(commit).not.toMatch(/BigInt\(Date\.now\(\)\)/);
    expect(commit).toMatch(/expiresAt: new Date\(chainNow \+ ttlMs\)/);
    const release = src.slice(src.indexOf('export const postReleases = guard'));
    expect(release).toMatch(/const since = new Date\(chainNow - /);
  });
});
