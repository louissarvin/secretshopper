import { NEAR, fastnearHeaders } from './client.ts';
import { createLogger } from '../../utils/logger.ts';
import { RateLimitedError, retryAfterMs } from './rateLimit.ts';

const log = createLogger('near-events');

export interface ContractEventRow {
  receiptId: string;
  logIndex: number;
  txHash: string;
  blockHeight: bigint;
  blockTime: Date;
  contractId: string;
  standard: string;
  version: string;
  event: string;
  data: object;
}

interface ReceiptOutcome {
  id: string;
  executorId: string;
  logs: string[];
  status: Record<string, unknown>;
  blockHeight: number | string;
  blockTimestampNs: number | string;
  txHash: string;
}

interface TxApiReceipt {
  execution_outcome: {
    id: string;
    block_height: number;
    block_timestamp: number | string;
    outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> };
  };
}

interface TxApiTransaction {
  transaction: { hash: string; signer_id?: string; receiver_id?: string; actions?: unknown[] };
  receipts: TxApiReceipt[];
}

const EVENT_PREFIX = 'EVENT_JSON:';

const RETRYABLE = new Set([429, 502, 503, 504]);

const postTxApi = async <T>(path: string, body: unknown, attempts = 4): Promise<T> => {
  for (let i = 0; ; i++) {
    const res = await fetch(`${NEAR.txApiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...fastnearHeaders(NEAR.txApiUrl) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return (await res.json()) as T;
    const after = retryAfterMs(res.headers.get('retry-after'));
    if (!RETRYABLE.has(res.status) || i + 1 >= attempts) {
      // a 429 carries Retry-After to the caller, so a background job can back off for at least that long
      if (res.status === 429) throw new RateLimitedError(`FastNEAR tx API ${path} failed: 429`, after);
      throw new Error(`FastNEAR tx API ${path} failed: ${res.status}`);
    }
    // honour Retry-After when sent (at most 30 s here), else exponential backoff from 1 s
    await Bun.sleep(after !== null ? Math.min(after, 30_000) : 1000 * 2 ** i);
  }
};

// Tx hashes where the contract received a receipt, in [from, to) by tx block height.
// `attempts: 1` (background indexer): a 429 is thrown at once with its Retry-After instead of sleeping in the tick.
export const listContractTxHashes = async (contractId: string, from: number, to: number, attempts = 4): Promise<string[]> => {
  const hashes = new Set<string>();
  let resumeToken: string | undefined;
  do {
    const page = await postTxApi<{ account_txs: { transaction_hash: string }[]; resume_token: string }>('/v0/account', {
      account_id: contractId,
      is_receiver: true,
      from_tx_block_height: from,
      to_tx_block_height: to,
      desc: false,
      limit: 200,
      ...(resumeToken ? { resume_token: resumeToken } : {}),
    }, attempts);
    page.account_txs.forEach((row) => hashes.add(row.transaction_hash));
    resumeToken = page.account_txs.length === 200 ? page.resume_token : undefined;
  } while (resumeToken);
  return [...hashes];
};

export const fetchTransactions = async (hashes: string[], attempts = 4): Promise<TxApiTransaction[]> => {
  const out: TxApiTransaction[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const { transactions } = await postTxApi<{ transactions: TxApiTransaction[] }>('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) }, attempts);
    out.push(...transactions);
  }
  return out;
};

/** First transaction of an account (oldest first), or null if it has none. Used for account age. */
export const firstAccountTx = async (accountId: string): Promise<{ blockHeight: number; at: Date } | null> => {
  const page = await postTxApi<{ account_txs: { tx_block_height: number; tx_block_timestamp: string }[] }>('/v0/account', {
    account_id: accountId,
    desc: false,
    limit: 1,
  });
  const row = page.account_txs[0];
  return row ? { blockHeight: row.tx_block_height, at: new Date(Number(BigInt(row.tx_block_timestamp) / 1_000_000n)) } : null;
};

/** Hashes of txs `accountId` signed itself, newest first, scanning at most `maxRows` of its txs. */
export const listSignedCallHashes = async (accountId: string, maxRows: number): Promise<{ hashes: string[]; truncated: boolean }> => {
  const hashes: string[] = [];
  let resumeToken: string | undefined;
  let rows = 0;
  do {
    const page = await postTxApi<{ account_txs: { transaction_hash: string; is_real_signer?: boolean }[]; resume_token?: string }>(
      '/v0/account',
      { account_id: accountId, is_signer: true, desc: true, limit: 200, ...(resumeToken ? { resume_token: resumeToken } : {}) },
      2
    );
    rows += page.account_txs.length;
    // is_function_call on a row describes this account's role, not the tx, so actions are checked on the tx bodies
    for (const r of page.account_txs) if (r.is_real_signer !== false) hashes.push(r.transaction_hash);
    resumeToken = page.account_txs.length === 200 ? page.resume_token : undefined;
  } while (resumeToken && rows < maxRows);
  return { hashes: [...new Set(hashes)], truncated: !!resumeToken };
};

/** First tx an account received with its block height (for a plan-made vault: its creation tx); null when not indexed yet. */
export const firstReceivedTx = async (accountId: string): Promise<{ hash: string; blockHeight: number } | null> => {
  const page = await postTxApi<{ account_txs: { transaction_hash: string; tx_block_height: number }[] }>('/v0/account', { account_id: accountId, is_receiver: true, desc: false, limit: 1 }, 2);
  const row = page.account_txs[0];
  return row ? { hash: row.transaction_hash, blockHeight: row.tx_block_height } : null;
};

/** Hash of the first tx an account received (its creation tx), or null if the tx API has none yet. One attempt: callers serve without it. */
export const firstIncomingTxHash = async (accountId: string): Promise<string | null> => {
  const page = await postTxApi<{ account_txs: { transaction_hash: string }[] }>('/v0/account', { account_id: accountId, is_receiver: true, desc: false, limit: 1 }, 1);
  return page.account_txs[0]?.transaction_hash ?? null;
};

// Only successful receipts executed by our contract: a panicked receipt keeps its logs but its state was reverted.
export const parseOutcomeEvents = (o: ReceiptOutcome, contractId: string, standard: string): ContractEventRow[] => {
  if (o.executorId !== contractId) return [];
  if (!('SuccessValue' in o.status) && !('SuccessReceiptId' in o.status)) return [];
  const rows: ContractEventRow[] = [];
  o.logs.forEach((line, logIndex) => {
    if (!line.startsWith(EVENT_PREFIX)) return;
    try {
      const ev = JSON.parse(line.slice(EVENT_PREFIX.length)) as { standard?: string; version?: string; event?: string; data?: unknown };
      if (ev.standard !== standard || typeof ev.event !== 'string') return;
      rows.push({
        receiptId: o.id,
        logIndex,
        txHash: o.txHash,
        blockHeight: BigInt(o.blockHeight),
        blockTime: new Date(Number(BigInt(o.blockTimestampNs) / 1_000_000n)),
        contractId,
        standard: ev.standard,
        version: String(ev.version ?? ''),
        event: ev.event,
        // NEP-297 allows data as an object or a one-element array (NEP-171 style); accept both
        data:(Array.isArray(ev.data) ? ev.data[0] : ev.data) ?? {},
      });
    } catch {
      log.warn('unparseable event log', { receiptId: o.id, logIndex });
    }
  });
  return rows;
};

export const parseTxEvents = (tx: TxApiTransaction, contractId: string, standard: string): ContractEventRow[] =>
  (tx.receipts ?? []).flatMap(({ execution_outcome: eo }) =>
    parseOutcomeEvents(
      {
        id: eo.id,
        executorId: eo.outcome.executor_id,
        logs: eo.outcome.logs,
        status: eo.outcome.status,
        blockHeight: eo.block_height,
        blockTimestampNs: eo.block_timestamp,
        txHash: tx.transaction.hash,
      },
      contractId,
      standard
    )
  );
