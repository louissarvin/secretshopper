import { describe, expect, test } from 'bun:test';
import { createGetVendor, isActive } from '../src/vendor.ts';

const NOW = 1_800_000_000_000;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

describe('B11 get_vendor reads approved payees from the vault', () => {
  const getVendor = createGetVendor({
    vendorRecord: async (id) => (id === 'v1' ? { id: 'v1', legalName: 'Acme', approvedPayees: [{ account: 'evil.near' }] } : null),
    approvedPayees: async () => [
      { account_id: 'acme.near', label: 'Acme Hosting', active_at: ns(NOW - 1000), removed_at: null },
      { account_id: 'new.near', label: 'Acme new account', active_at: ns(NOW + 60_000), removed_at: null },
      { account_id: 'leaving.near', label: 'Old account', active_at: ns(NOW - 9000), removed_at: ns(NOW + 5000) },
      { account_id: 'gone.near', label: 'Delisted', active_at: ns(NOW - 9000), removed_at: ns(NOW - 1) },
    ],
    nowMs: () => NOW,
  });

  test('database payees are dropped; only active on-chain payees are approved', async () => {
    const v = (await getVendor('v1')) as Record<string, unknown>;
    expect(v.approvedPayees).toBeUndefined();
    expect(v.approved_payees).toEqual([
      { account_id: 'acme.near', label: 'Acme Hosting' },
      { account_id: 'leaving.near', label: 'Old account', delisted_at: new Date(NOW + 5000).toISOString() },
    ]);
    expect((v.pending_payees as unknown[]).length).toBe(1);
  });

  test('a payee is approved only while active_at <= t < removed_at', () => {
    const t = BigInt(NOW) * 1_000_000n;
    expect(isActive({ active_at: ns(NOW), removed_at: null }, t)).toBe(true);
    expect(isActive({ active_at: ns(NOW + 1), removed_at: null }, t)).toBe(false);
    expect(isActive({ active_at: ns(NOW - 5), removed_at: ns(NOW) }, t)).toBe(false);
    expect(isActive({ active_at: ns(NOW - 5), removed_at: ns(NOW + 1) }, t)).toBe(true);
  });

  test('unknown vendor stays null', async () => expect(await getVendor('nope')).toBeNull());
});
