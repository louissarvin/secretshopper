import { AccountDoesNotExistError, ContractExecutionError, GlobalContractCodeDoesNotExistError } from 'near-api-js/rpc-errors';
import { rpc } from './client.ts';
import type { AccessKeyEntry, AccountState, VaultChain } from '../vault/plan.ts';

// Single provider: "does not exist" is an answer here, and the failover provider would wrap it (14 §10.2).
// Missing account, code or method is null; anything else (RPC down, timeouts) throws so callers answer 502.

const missing = (e: unknown) => e instanceof AccountDoesNotExistError || e instanceof ContractExecutionError;

// Code published by hash is immutable, so a positive answer never changes; each check downloads the wasm.
const published = new Set<string>();

export const vaultChain: VaultChain = {
  async account(accountId): Promise<AccountState | null> {
    try {
      const a = await rpc.viewAccount({ accountId });
      return { amount: a.amount, locked: a.locked, storageUsage: a.storage_usage, codeHash: a.code_hash, globalCodeHash: a.global_contract_hash ?? null };
    } catch (e) {
      if (e instanceof AccountDoesNotExistError) return null;
      throw e;
    }
  },
  async globalCodePublished(codeHash) {
    if (published.has(codeHash)) return true;
    try {
      await rpc.viewGlobalContractCode({ identifier: { codeHash } });
    } catch (e) {
      if (e instanceof GlobalContractCodeDoesNotExistError) return false;
      throw e;
    }
    published.add(codeHash);
    return true;
  },
  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T | null> {
    try {
      return ((await rpc.callFunction({ contractId, method, args })) ?? null) as T | null;
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  },
  async accessKeys(accountId): Promise<AccessKeyEntry[]> {
    return (await rpc.viewAccessKeyList({ accountId, finalityQuery: { finality: 'final' } })).keys as AccessKeyEntry[];
  },
};
