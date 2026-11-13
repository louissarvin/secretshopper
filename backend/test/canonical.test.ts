import { describe, expect, test } from 'bun:test';
import { canonicalJson, invoiceIdOf } from '../src/utils/canonical.ts';

// Same algorithm as the browser version (web/src/lib/near/commitment.ts), via WebCrypto.
const browserInvoiceIdOf = async (doc: unknown): Promise<string> => {
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
        : v;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sortKeys(doc))));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
};

const doc = { b: 1, a: [{ d: 2, c: 3 }], z: { k: 'v', e: null } };

describe('canonical invoice id', () => {
  test('pinned value (Python json.dumps sort_keys, compact separators)', () => {
    expect(canonicalJson(doc)).toBe('{"a":[{"c":3,"d":2}],"b":1,"z":{"e":null,"k":"v"}}');
    expect(invoiceIdOf(doc)).toBe('655700b067bc608c3172ecab121274f76859e2fa1d7c104b590570fa7cd68911');
  });

  test('stable under key order at every depth', () => {
    const reordered = { z: { e: null, k: 'v' }, a: [{ c: 3, d: 2 }], b: 1 };
    expect(invoiceIdOf(reordered)).toBe(invoiceIdOf(doc));
  });

  test('array order is significant', () => {
    expect(invoiceIdOf({ a: [1, 2] })).not.toBe(invoiceIdOf({ a: [2, 1] }));
  });

  test('lowercase 64-hex, accepted by the contract', () => {
    expect(invoiceIdOf(doc)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('matches the browser implementation', async () => {
    const realistic = { vendor_id: 'cm0abc', number: 'INV-1042', lines: [{ qty: 2, desc: 'Widgets ü' }], total: '12.50', pay_to: 'acme.testnet' };
    expect(await browserInvoiceIdOf(realistic)).toBe(invoiceIdOf(realistic));
  });
});
