import { describe, expect, test } from 'bun:test';
import { canSign, commitAllowed, decidePreflight, LOW_FLOAT_YOCTO, lureAllowance, withinCapacity, type PreflightFacts } from '../src/tester/preflight.ts';
import { TESTER_STATES } from '../src/lib/proof/testerKey.ts';
import type { Mode } from '../src/lib/near/shop.ts';

const ok = { ok: true as const, allowanceYocto: 10n ** 24n };
const base: PreflightFacts = { ownerId: 'o.testnet', signerId: 'o.testnet', key: ok };
const commit: NonNullable<PreflightFacts['commit']> = {
  mode: 'Armed' as Mode,
  vendors: 1,
  batchSize: 4,
  maxBatchSize: 10,
  policyOk: true,
  headroomYocto: LOW_FLOAT_YOCTO,
  withinCapacity: true,
  luresLeftToday: 5,
};

describe('tester preflight (multi-vault)', () => {
  test('signing checks: owner first, then the key', () => {
    expect(decidePreflight(base)).toBe('ok');
    expect(decidePreflight({ ...base, ownerId: 'new-owner.testnet' })).toBe('owner_changed');
    expect(decidePreflight({ ...base, ownerId: 'x.testnet', key: { ok: false, code: 'key_missing' } })).toBe('owner_changed');
    for (const code of ['key_missing', 'key_scope', 'allowance_unlimited', 'allowance_low'] as const) {
      expect(decidePreflight({ ...base, key: { ok: false, code } })).toBe(code);
    }
  });

  test('commit checks in order: unarmed, no vendors, policy, float, capacity, budget', () => {
    const c = (over: Partial<typeof commit>) => decidePreflight({ ...base, commit: { ...commit, ...over } });
    expect(c({})).toBe('ok');
    expect(c({ mode: 'Demoted' })).toBe('ok');
    expect(c({ mode: 'Unarmed' })).toBe('unarmed');
    expect(c({ mode: 'Frozen' })).toBe('unarmed');
    expect(c({ vendors: 0 })).toBe('no_vendors');
    expect(c({ batchSize: 11 })).toBe('policy_unsupported');
    expect(c({ policyOk: false })).toBe('policy_unsupported');
    expect(c({ headroomYocto: LOW_FLOAT_YOCTO - 1n })).toBe('low_float');
    expect(c({ withinCapacity: false })).toBe('over_capacity');
    expect(c({ luresLeftToday: 0 })).toBe('budget');
    expect(c({ mode: 'Unarmed', vendors: 0, withinCapacity: false })).toBe('unarmed'); // cheapest first
    expect(decidePreflight({ ...base, key: { ok: false, code: 'key_scope' }, commit: { ...commit, mode: 'Unarmed' } })).toBe('key_scope');
  });

  test('reveal, release and prove need only owner and key; budget still commits (voids), the rest skip', () => {
    for (const s of TESTER_STATES) {
      expect(canSign(s)).toBe(!['owner_changed', 'key_missing', 'key_scope', 'allowance_unlimited', 'allowance_low', 'provisioning'].includes(s));
      expect(commitAllowed(s)).toBe(s === 'ok' || s === 'budget');
    }
    expect(canSign(null)).toBe(true); // before the first preflight the tester tries; a refused tx costs nothing on chain
  });

  test('capacity keeps the oldest enabled vaults', () => {
    const d = (h: number) => new Date(Date.UTC(2026, 10, 13, h));
    const served = withinCapacity(
      [
        { shop: 'c.testnet', enabledAt: d(3) },
        { shop: 'a.testnet', enabledAt: d(1) },
        { shop: 'b.testnet', enabledAt: d(2) },
        { shop: 'z.testnet', enabledAt: null },
      ],
      2
    );
    expect([...served].sort()).toEqual(['a.testnet', 'b.testnet']);
    expect(withinCapacity([{ shop: 'a.testnet', enabledAt: d(1) }], 0).size).toBe(0);
  });

  test('lure slots: per-batch cap and daily budget for other vaults, unchanged for the default', () => {
    expect(lureAllowance(true, 4, 3, 1000, 30)).toBe(4);
    expect(lureAllowance(false, 4, 3, 0, 30)).toBe(3);
    expect(lureAllowance(false, 2, 3, 0, 30)).toBe(2);
    expect(lureAllowance(false, 4, 3, 29, 30)).toBe(1);
    expect(lureAllowance(false, 4, 3, 31, 30)).toBe(0);
  });
});
