import { isVaultAgentScope, keyScope } from '../proof/accessKeys.ts';
import type { AccessKeyEntry, VaultChain } from './plan.ts';

// Live view of any Secret Shopper vault, registered or not. Pure: chain reads come in through `VaultChain`.

const MAX_KEYS_SHOWN = 100; // a vault holds the agent key and at most a stale one; past this `truncated` is set, counts stay exact (NF-03)

export interface VaultKey {
  publicKey: string;
  kind: 'full' | 'function_call' | 'unknown';
  variant: string;
  receiverId?: string;
  methodNames?: string[];
}

export interface VaultView {
  vaultId: string;
  codeHash: string;
  storageUsage: number;
  balanceYocto: string;
  keys: AccessKeyEntry[]; // view_access_key_list items as the RPC returns them
  // counts cover every key the RPC returned, never only the shown ones
  keySummary: { count: number; fullAccess: number; nonAgentKeys: number; truncated: boolean; items: VaultKey[] };
  status: unknown;
  scorecard: unknown;
  policy: unknown;
}

export type VaultRead =
  | { kind: 'missing' }
  | { kind: 'foreign'; codeHash: string } // the account's own code hash: other code, classic deploy or never initialized
  | { kind: 'vault'; vault: VaultView };

/** A vault only if the account runs `codeHash` as a global contract (by hash) and `new` has run. */
export const readVault = async (chain: VaultChain, vaultId: string, codeHash: string): Promise<VaultRead> => {
  const acct = await chain.account(vaultId);
  if (!acct) return { kind: 'missing' };
  const actual = acct.globalCodeHash ?? acct.codeHash;
  if (!codeHash || acct.globalCodeHash !== codeHash) return { kind: 'foreign', codeHash: actual };
  const [keys, status, scorecard, policy] = await Promise.all([
    chain.accessKeys(vaultId),
    chain.view<unknown>(vaultId, 'get_status'),
    chain.view<unknown>(vaultId, 'get_scorecard'),
    chain.view<unknown>(vaultId, 'get_policy'),
  ]);
  // with the code attached but `new` never run, every view panics
  if (status === null || scorecard === null || policy === null) return { kind: 'foreign', codeHash: actual };
  const scopes = keys.map((k) => keyScope(k.access_key.permission));
  const vault: VaultView = {
    vaultId,
    codeHash,
    storageUsage: acct.storageUsage,
    balanceYocto: acct.amount.toString(),
    keys: keys.slice(0, MAX_KEYS_SHOWN),
    keySummary: {
      count: keys.length,
      fullAccess: scopes.filter((s) => s.kind === 'full').length,
      nonAgentKeys: scopes.filter((s) => !isVaultAgentScope(s, vaultId)).length,
      truncated: keys.length > MAX_KEYS_SHOWN,
      items: keys.slice(0, MAX_KEYS_SHOWN).map((k, i) => {
        const s = scopes[i];
        return s.kind === 'function_call'
          ? { publicKey: k.public_key, kind: s.kind, variant: s.variant, receiverId: s.receiverId, methodNames: s.methodNames }
          : { publicKey: k.public_key, kind: s.kind, variant: s.variant };
      }),
    },
    status,
    scorecard,
    policy,
  };
  return { kind: 'vault', vault };
};
