import { keyScope } from './accessKeys.ts';

// Tester key scope check, shared by the API's enable route and the tester's preflight.
// Pure: `keys` is view_access_key_list of the vault owner, as the RPC returns it.

export const TESTER_METHODS = ['commit_batch', 'prove_delivery', 'release', 'reveal'] as const; // sorted

export type TesterKeyCheck =
  | { ok: true; allowanceYocto: bigint }
  | { ok: false; code: 'key_missing' | 'key_scope' | 'allowance_unlimited' | 'allowance_low' };

export const TESTER_STATES = [
  'ok',
  'provisioning',
  'key_missing',
  'key_scope',
  'allowance_unlimited',
  'allowance_low',
  'owner_changed',
  'unarmed',
  'no_vendors',
  'policy_unsupported',
  'low_float',
  'over_capacity',
  'budget',
  'error',
] as const;
export type TesterState = (typeof TESTER_STATES)[number];

export interface OwnerKeyEntry {
  public_key: string;
  access_key: { nonce?: number; permission: unknown };
}

const sameMethods = (methods: string[]) => {
  const sorted = [...methods].sort();
  return sorted.length === TESTER_METHODS.length && sorted.every((m, i) => m === TESTER_METHODS[i]);
};

/**
 * Exactly a plain FunctionCall key to `vaultId` with exactly TESTER_METHODS and a finite allowance of at least
 * `minAllowanceYocto`. FullAccess, gas keys and unknown permissions are `key_scope` (fail closed); an unlimited
 * allowance is refused so a leaked seed cannot burn an owner's whole balance on gas.
 */
export const checkTesterKey = (keys: OwnerKeyEntry[], publicKey: string, vaultId: string, minAllowanceYocto: bigint): TesterKeyCheck => {
  const entry = keys.find((k) => k.public_key === publicKey);
  if (!entry) return { ok: false, code: 'key_missing' };
  const scope = keyScope(entry.access_key.permission);
  if (scope.kind !== 'function_call' || scope.variant !== 'FunctionCall' || scope.receiverId !== vaultId || !sameMethods(scope.methodNames))
    return { ok: false, code: 'key_scope' };
  const allowance = (entry.access_key.permission as { FunctionCall: { allowance?: unknown } }).FunctionCall.allowance;
  if (allowance === null || allowance === undefined) return { ok: false, code: 'allowance_unlimited' };
  if (typeof allowance !== 'string' || !/^\d{1,39}$/.test(allowance)) return { ok: false, code: 'key_scope' };
  const yocto = BigInt(allowance);
  return yocto < minAllowanceYocto ? { ok: false, code: 'allowance_low' } : { ok: true, allowanceYocto: yocto };
};
