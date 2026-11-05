import { describe, expect, test } from 'bun:test';
import { checkTesterKey, TESTER_METHODS, TESTER_STATES, type OwnerKeyEntry } from '../src/lib/proof/testerKey.ts';

const VAULT = 'selfserve-e2e.ss-owner-e9c3db.testnet';
const PK = 'ed25519:4PFFPNtesterkeytesterkeytesterkeytesterkey1';
const MIN = 10n ** 23n; // 0.1 NEAR
const fc = (over: Record<string, unknown> = {}) => ({ FunctionCall: { receiver_id: VAULT, method_names: ['reveal', 'release', 'commit_batch', 'prove_delivery'], allowance: '1000000000000000000000000', ...over } });
const keys = (permission: unknown, pk = PK): OwnerKeyEntry[] => [
  { public_key: 'ed25519:other', access_key: { nonce: 1, permission: 'FullAccess' } },
  { public_key: pk, access_key: { nonce: 5, permission } },
];

describe('checkTesterKey', () => {
  test('the exact method set to the vault with a finite allowance passes, in any method order', () => {
    expect(checkTesterKey(keys(fc()), PK, VAULT, MIN)).toEqual({ ok: true, allowanceYocto: 10n ** 24n });
    expect(TESTER_METHODS).toEqual(['commit_batch', 'prove_delivery', 'release', 'reveal']);
  });

  test('absent key is key_missing', () => {
    expect(checkTesterKey(keys(fc(), 'ed25519:someoneelse'), PK, VAULT, MIN)).toEqual({ ok: false, code: 'key_missing' });
    expect(checkTesterKey([], PK, VAULT, MIN)).toEqual({ ok: false, code: 'key_missing' });
  });

  test('extra or missing method, another receiver, FullAccess, gas keys and unknown permissions are key_scope', () => {
    for (const p of [
      fc({ method_names: [...TESTER_METHODS, 'pay'] }),
      fc({ method_names: ['commit_batch', 'release', 'reveal'] }),
      fc({ method_names: ['commit_batch', 'commit_batch', 'release', 'reveal'] }),
      fc({ method_names: [] }), // empty means every method on NEAR
      fc({ receiver_id: 'shop4.ss-owner-e9c3db.testnet' }),
      'FullAccess',
      { GasKeyFullAccess: { balance: '1', num_nonces: 1 } },
      { GasKeyFunctionCall: { receiver_id: VAULT, method_names: [...TESTER_METHODS], allowance: null, balance: '1', num_nonces: 1 } },
      { SomethingNew: {} },
      null,
      fc({ allowance: 12 }),
    ])
      expect(checkTesterKey(keys(p), PK, VAULT, MIN)).toEqual({ ok: false, code: 'key_scope' });
  });

  test('null allowance is allowance_unlimited; below the minimum is allowance_low; exactly the minimum passes', () => {
    expect(checkTesterKey(keys(fc({ allowance: null })), PK, VAULT, MIN)).toEqual({ ok: false, code: 'allowance_unlimited' });
    expect(checkTesterKey(keys(fc({ allowance: (MIN - 1n).toString() })), PK, VAULT, MIN)).toEqual({ ok: false, code: 'allowance_low' });
    expect(checkTesterKey(keys(fc({ allowance: MIN.toString() })), PK, VAULT, MIN)).toEqual({ ok: true, allowanceYocto: MIN });
  });

  test('the states list carries every check code', () => {
    for (const c of ['key_missing', 'key_scope', 'allowance_unlimited', 'allowance_low'] as const) expect(TESTER_STATES).toContain(c);
  });
});
