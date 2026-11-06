import { Account, JsonRpcProvider, KeyPair, teraToGas, type KeyPairString } from 'near-api-js';
import { AccountDoesNotExistError } from 'near-api-js/rpc-errors';
import type { AccountFacts, Mode, Rail } from './tools.ts';
import { isActive, type ChainPayee } from './vendor.ts';
import type { SpendLimits } from './preflight.ts';

export interface Status {
  mode: Mode;
  agent_key: string | null;
  pending_key: string | null;
  armed_at: string;
  spent_24h: string;
  owner_id: string;
  vendor_id: string;
  token_id: string;
  intents_id: string | null;
  version?: string;
}

/** The get_policy fields the agent reads; amounts are token base units, times ns. */
export interface PolicyView {
  max_per_payment: string;
  daily_cap: string;
  max_payments_per_day: number;
  max_new_payees_per_day: number;
  max_decisions_per_day: number;
  key_nonces?: number; // 0 classic FC key, 1 to 64 gas key lanes (2.3.0)
}

/** Release tick on the vault (contract 2.3.0+, v2/32): the tester's root and, once signed, the agent's ack. */
export interface Release {
  root: string;
  count: number;
  at: string;
  ack: { root: string; at: string; key: string } | null;
}

export interface VaultOptions {
  rpcUrl: string;
  vaultId: string;
  privateKey: string; // FC key on the vault: pay,decline,ack or propose,decline,ack
  txApiUrl?: string; // FastNEAR Transactions API for account age; omitted on a local sandbox
  fastnearApiKey?: string;
  payTgas: number;
  payIntentsTgas?: number; // Intents pays carry a 100 Tgas ft_transfer_call to the verifier (v2/31)
  callTgas: number;
  listedOnly: boolean; // pay(.., listed_only): the contract refuses payees not approved on the vault
}

const EMPTY_CODE_HASH = '11111111111111111111111111111111';
const HISTORY_WINDOW_NS = 24n * 3600n * 1_000_000_000n; // inside the ~5 epochs a non-archival RPC keeps
const SAMPLE_BLOCKS = 1000;

type AccountCode = { code_hash: string; global_contract_hash?: string | null; global_contract_account_id?: string | null };
const contractOf = (a: AccountCode): AccountFacts['contract'] =>
  a.global_contract_account_id
    ? { kind: 'global_account', id: a.global_contract_account_id }
    : a.global_contract_hash
      ? { kind: 'global_hash', id: a.global_contract_hash }
      : a.code_hash !== EMPTY_CODE_HASH
        ? { kind: 'local', id: a.code_hash }
        : null;
// exact domain or a subdomain: a bare suffix match would also send the key to evilfastnear.com (AG-05)
export const isFastnearHost = (url: string): boolean => {
  const h = new URL(url).hostname;
  return h === 'fastnear.com' || h.endsWith('.fastnear.com');
};
const sameContract = (x: AccountFacts['contract'], y: AccountFacts['contract']) => x?.kind === y?.kind && x?.id === y?.id;

/** Chain access for the agent. The signer is the vault account itself, holding only the agent's FC key. */
export const createVault = (o: VaultOptions) => {
  const auth = (url: string) => (o.fastnearApiKey && isFastnearHost(url) ? { Authorization: `Bearer ${o.fastnearApiKey}` } : undefined);
  // Single provider: "account does not exist" must surface as such, not as a failover error.
  const provider = new JsonRpcProvider({ url: o.rpcUrl, headers: auth(o.rpcUrl) }, { retries: 3, backoff: 2, wait: 500 });
  const account = new Account(o.vaultId, provider, o.privateKey as KeyPairString);

  const viewVault = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> =>
    (await provider.callFunction({ contractId: o.vaultId, method, args })) as T;

  // Oldest transaction of the account via the FastNEAR Transactions API; null if none or unavailable.
  const firstSeenOnChain = async (accountId: string): Promise<{ at: string; block: number } | null> => {
    if (!o.txApiUrl) return null;
    try {
      const res = await fetch(`${o.txApiUrl}/v0/account`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(o.txApiUrl) },
        body: JSON.stringify({ account_id: accountId, desc: false, limit: 1 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const row = ((await res.json()) as { account_txs?: { tx_block_height: number; tx_block_timestamp: string }[] }).account_txs?.[0];
      return row ? { at: new Date(Number(BigInt(row.tx_block_timestamp) / 1_000_000n)).toISOString(), block: row.tx_block_height } : null;
    } catch {
      return null;
    }
  };

  type Header = { height: number; ts: bigint };
  const header = (b: { header: { height: number; timestamp_nanosec: string } }): Header => ({ height: b.header.height, ts: BigInt(b.header.timestamp_nanosec) });
  // heights can be skipped (no block produced) or garbage-collected; walk down a few
  const blockAtOrBelow = async (height: number): Promise<Header | null> => {
    for (let h = Math.max(1, height), tries = 0; h >= 1 && tries < 5; h--, tries++) {
      try {
        return header(await provider.viewBlock({ blockId: h }));
      } catch {
        // UNKNOWN_BLOCK: missing or garbage-collected height
      }
    }
    return null;
  };

  /** Compares view_account now with a block about 24 h back: did the account exist, did its code change. */
  const codeHistory = async (accountId: string, now: AccountFacts['contract']): Promise<AccountFacts['code_history']> => {
    try {
      const tip = header(await provider.viewBlock({ finality: 'final' }));
      const sample = await blockAtOrBelow(tip.height - SAMPLE_BLOCKS);
      if (!sample || sample.height >= tip.height) return null;
      const nsPerBlock = (tip.ts - sample.ts) / BigInt(tip.height - sample.height);
      const start = await blockAtOrBelow(tip.height - Number(HISTORY_WINDOW_NS / (nsPerBlock > 0n ? nsPerBlock : 1n)));
      if (!start) return null;
      const covered_hours = Number((tip.ts - start.ts) / 1_000_000n) / 3_600_000;
      try {
        const past = await provider.viewAccount({ accountId, blockQuery: { blockId: start.height } });
        return { covered_hours, existed_at_start: true, code_changed: !sameContract(contractOf(past), now) };
      } catch (e) {
        if (e instanceof AccountDoesNotExistError) return { covered_hours, existed_at_start: false, code_changed: now !== null };
        return null;
      }
    } catch {
      return null;
    }
  };

  const call = async (methodName: string, args: Record<string, unknown>, tgas: number) => {
    const outcome = await account.callFunctionRaw({ contractId: o.vaultId, methodName, args, gas: teraToGas(tgas), deposit: 0n, waitUntil: 'FINAL' });
    return { ok: true, txHash: outcome.transaction.hash };
  };

  return {
    provider,
    publicKey: (): string => KeyPair.fromString(o.privateKey as KeyPairString).getPublicKey().toString(),
    getStatus: () => viewVault<Status>('get_status'),
    getPolicy: () => viewVault<PolicyView>('get_policy'),
    getDecision: (invoiceId: string) => viewVault<unknown | null>('get_decision', { invoice_id: invoiceId }),

    /** All on-chain approved payees (v2 add_payee), paged. */
    getApprovedPayees: async (): Promise<ChainPayee[]> => {
      const out: ChainPayee[] = [];
      for (;;) {
        const page = await viewVault<ChainPayee[]>('get_payees', { from: out.length, limit: 100 });
        out.push(...page);
        if (page.length < 100) return out;
      }
    },

    /** Counterparty signals for the model: existence, code, first touch by this vault, account age. */
    accountFacts: async (accountId: string): Promise<AccountFacts> => {
      const [acct, seen, approved, firstTx] = await Promise.all([
        provider.viewAccount({ accountId }).catch((e: unknown) => {
          if (e instanceof AccountDoesNotExistError) return null;
          throw e; // a network error must not read as "account does not exist"
        }),
        viewVault<{ at: string; via_proposal: boolean } | null>('get_payee', { account_id: accountId }),
        viewVault<ChainPayee | null>('get_payee_status', { account_id: accountId }),
        firstSeenOnChain(accountId),
      ]);
      const contract = acct ? contractOf(acct) : null;
      return {
        account_id: accountId,
        exists: acct !== null,
        hasContract: contract !== null,
        contract,
        code_history: acct ? await codeHistory(accountId, contract) : null,
        first_seen_by_vault: seen ? new Date(Number(BigInt(seen.at) / 1_000_000n)).toISOString() : null,
        approved_payee: approved
          ? {
              label: approved.label,
              active: isActive(approved, BigInt(Date.now()) * 1_000_000n),
              active_at: new Date(Number(BigInt(approved.active_at) / 1_000_000n)).toISOString(),
              removed_at: approved.removed_at ? new Date(Number(BigInt(approved.removed_at) / 1_000_000n)).toISOString() : null,
            }
          : null,
        first_tx_at: firstTx?.at ?? null,
      };
    },

    /** Caps the contract enforces on pay; the preflight checks them before signing. */
    spendLimits: async (): Promise<SpendLimits> => {
      const [policy, status] = await Promise.all([viewVault<{ max_per_payment: string; daily_cap: string }>('get_policy'), viewVault<Status>('get_status')]);
      return { max_per_payment: BigInt(policy.max_per_payment), daily_cap: BigInt(policy.daily_cap), spent_24h: BigInt(status.spent_24h) };
    },

    pay: (invoiceId: string, payee: string, amount: string, rail: Rail) =>
      call('pay', { invoice_id: invoiceId, payee, amount, rail, listed_only: o.listedOnly }, rail === 'Intents' ? (o.payIntentsTgas ?? 150) : o.payTgas),
    propose: (invoiceId: string, payee: string, amount: string, rail: Rail) => call('propose', { invoice_id: invoiceId, payee, amount, rail }, o.callTgas),
    decline: (invoiceId: string, reason: string) => call('decline', { invoice_id: invoiceId, reason }, o.callTgas),

    // Harness work, not a model tool: signs the root of a tick the inbox delivered (v2/32).
    getRelease: (releaseAtNs: string) => viewVault<Release | null>('get_release', { release_at: releaseAtNs }),
    ack: (releaseAtNs: string, root: string) => call('ack', { release_at: releaseAtNs, root }, o.callTgas),
  };
};

export type Vault = ReturnType<typeof createVault>;
