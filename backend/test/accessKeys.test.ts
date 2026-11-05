import { describe, expect, test } from 'bun:test';
import { isVaultAgentScope, keyScope } from '../src/lib/proof/accessKeys.ts';

// Shapes from near-api-js 7.4 AccessKeyPermissionView (view_access_key_list JSON).
const VAULT = 'shop.owner.testnet';
const fc = { receiver_id: VAULT, method_names: ['pay', 'decline'], allowance: '250000000000000000000000' };

describe('access key scope (verify-evidence check 1)', () => {
  test('FullAccess and GasKeyFullAccess are both full access', () => {
    expect(keyScope('FullAccess').kind).toBe('full');
    expect(keyScope({ GasKeyFullAccess: { balance: '1000', num_nonces: 4 } })).toEqual({ kind: 'full', variant: 'GasKeyFullAccess' });
  });

  test('FunctionCall and GasKeyFunctionCall keep receiver and methods', () => {
    expect(keyScope({ FunctionCall: fc })).toMatchObject({ kind: 'function_call', receiverId: VAULT, methodNames: ['pay', 'decline'] });
    expect(keyScope({ GasKeyFunctionCall: { ...fc, balance: '1', num_nonces: 2 } })).toMatchObject({ kind: 'function_call', variant: 'GasKeyFunctionCall' });
  });

  test('unknown or malformed permissions fail closed', () => {
    for (const p of [null, undefined, 'SomethingNew', {}, { FunctionCall: { receiver_id: VAULT } }, { FunctionCall: fc, FullAccess: true }, { NewKind: {} }]) {
      const s = keyScope(p);
      expect(s.kind).toBe('unknown');
      expect(isVaultAgentScope(s, VAULT)).toBe(false);
    }
  });

  test('only the vault with pay,decline or propose,decline (plus ack) is an agent scope', () => {
    expect(isVaultAgentScope(keyScope({ FunctionCall: fc }), VAULT)).toBe(true);
    expect(isVaultAgentScope(keyScope({ GasKeyFunctionCall: { ...fc, method_names: ['decline', 'propose'] } }), VAULT)).toBe(true);
    expect(isVaultAgentScope(keyScope({ FunctionCall: { ...fc, receiver_id: 'other.testnet' } }), VAULT)).toBe(false);
    expect(isVaultAgentScope(keyScope({ FunctionCall: { ...fc, method_names: [] } }), VAULT)).toBe(false);
    expect(isVaultAgentScope(keyScope({ GasKeyFullAccess: { balance: '1', num_nonces: 1 } }), VAULT)).toBe(false);
  });

  test('contract 2.3.0 agent keys with ack are agent scopes; no other extra method is', () => {
    expect(isVaultAgentScope(keyScope({ FunctionCall: { ...fc, method_names: ['pay', 'decline', 'ack'] } }), VAULT)).toBe(true);
    expect(isVaultAgentScope(keyScope({ GasKeyFunctionCall: { ...fc, method_names: ['propose', 'decline', 'ack'] } }), VAULT)).toBe(true);
    expect(isVaultAgentScope(keyScope({ FunctionCall: { ...fc, method_names: ['ack'] } }), VAULT)).toBe(false);
    expect(isVaultAgentScope(keyScope({ FunctionCall: { ...fc, method_names: ['pay', 'propose', 'decline', 'ack'] } }), VAULT)).toBe(false);
    expect(isVaultAgentScope(keyScope({ FunctionCall: { ...fc, method_names: ['pay', 'decline', 'release'] } }), VAULT)).toBe(false);
  });
});
