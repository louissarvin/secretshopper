// Access key permission views from view_access_key_list. nearcore also has gas keys (near-api-js 7.4
// AccessKeyPermissionView): GasKeyFullAccess is a full-access key and must be treated as one.

export type KeyScope =
  | { kind: 'full'; variant: 'FullAccess' | 'GasKeyFullAccess' }
  | { kind: 'function_call'; variant: 'FunctionCall' | 'GasKeyFunctionCall'; receiverId: string; methodNames: string[] }
  | { kind: 'unknown'; variant: string };

type FcView = { receiver_id?: unknown; method_names?: unknown };

const fcScope = (variant: 'FunctionCall' | 'GasKeyFunctionCall', v: FcView | undefined): KeyScope =>
  v && typeof v.receiver_id === 'string' && Array.isArray(v.method_names) && v.method_names.every((m) => typeof m === 'string')
    ? { kind: 'function_call', variant, receiverId: v.receiver_id, methodNames: v.method_names as string[] }
    : { kind: 'unknown', variant };

/** Unknown or malformed permissions are `unknown`, never `function_call`, so callers fail closed. */
export const keyScope = (permission: unknown): KeyScope => {
  if (permission === 'FullAccess') return { kind: 'full', variant: 'FullAccess' };
  if (typeof permission === 'string') return { kind: 'unknown', variant: permission.slice(0, 40) };
  if (!permission || typeof permission !== 'object') return { kind: 'unknown', variant: typeof permission };
  const p = permission as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length !== 1) return { kind: 'unknown', variant: keys.join(',').slice(0, 40) };
  if ('GasKeyFullAccess' in p) return { kind: 'full', variant: 'GasKeyFullAccess' };
  if ('FunctionCall' in p) return fcScope('FunctionCall', p.FunctionCall as FcView);
  if ('GasKeyFunctionCall' in p) return fcScope('GasKeyFunctionCall', p.GasKeyFunctionCall as FcView);
  return { kind: 'unknown', variant: keys[0].slice(0, 40) };
};

// Sorted method sets of an agent key: 2.3.0+ adds ack (delivery proof); 2.0 to 2.2 vaults such as shop2 hold the older pair.
const AGENT_METHOD_SETS = new Set(['ack,decline,pay', 'ack,decline,propose', 'decline,pay', 'decline,propose']);

/** The agent key on a vault: a function-call key to the vault itself with exactly pay,decline(,ack) or propose,decline(,ack). */
export const isVaultAgentScope = (s: KeyScope, vaultId: string): boolean => {
  if (s.kind !== 'function_call' || s.receiverId !== vaultId) return false;
  return AGENT_METHOD_SETS.has([...s.methodNames].sort().join(','));
};
