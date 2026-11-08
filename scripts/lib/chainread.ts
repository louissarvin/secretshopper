import { NEAR } from './net.ts';

// Raw chain reads for keeper.ts and verify-evidence.ts: no backend server, no database.

export const rpc = async <T>(method: string, params: unknown): Promise<T> => {
  const res = await fetch(NEAR.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { result?: T; error?: unknown };
  if (json.error || json.result === undefined) throw new Error(`rpc ${method}: ${JSON.stringify(json.error).slice(0, 300)}`);
  return json.result;
};

export type CommitSlotArg = { commitment: string; tlock_round: number; ciphertext_sha256: string };
export type CommitCall = { txHash: string; signerId: string; slots: CommitSlotArg[]; ciphertexts: string[] };

type TxAction = { FunctionCall?: { method_name: string; args: string }; UseGlobalContract?: { code_hash?: string; account_id?: string } } | string;
type Outcome = { executor_id: string; logs: string[]; status: Record<string, unknown> };
type TxView = {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: TxAction[] };
  status: Record<string, unknown>;
  receipts_outcome: { outcome: Outcome }[];
};

export const txView = (txHash: string, signerId: string): Promise<TxView> => rpc<TxView>('tx', { tx_hash: txHash, sender_account_id: signerId, wait_until: 'NONE' });

const ok = (status: Record<string, unknown>) => 'SuccessValue' in status || 'SuccessReceiptId' in status;
/** The tx succeeded and every receipt the receiver executed succeeded (a failed receipt's logs still exist on chain). */
const succeededAt = (t: TxView, executor: string): boolean =>
  ok(t.status) && t.receipts_outcome.filter((r) => r.outcome.executor_id === executor).every((r) => ok(r.outcome.status));
const kind = (a: TxAction): string => (typeof a === 'string' ? a : Object.keys(a)[0]);

export type Attestation = { ok: boolean; reasons: string[]; txHash?: string; codeHash?: string; init?: { owner_id: string; vendor_id: string; token_id: string; version: string } };

/**
 * V21-04: a code hash plus "no keys" does not prove a vault's state (NEP-616 accounts or a parent's creation
 * receipt can attach the real code over fabricated storage). A vault is attested only if its creation tx is exactly
 * [CreateAccount, Transfer, UseGlobalContract(code hash), FunctionCall new], signed by its parent, and the vault's
 * receipt succeeded and logged `initialized`: then no state existed before the genuine `new`.
 */
export const attestVault = async (shop: string, initTx?: { hash: string; signer: string }): Promise<Attestation> => {
  const reasons: string[] = [];
  const dot = shop.indexOf('.');
  if (dot < 0 || shop.startsWith('0s')) return { ok: false, reasons: [`${shop} has no parent account (implicit or deterministic id); its creation cannot be attested`] };
  const parent = shop.slice(dot + 1);
  const ref = initTx ?? (await firstTxTo(shop));
  if (!ref) return { ok: false, reasons: ['creation tx not found (pass --init-tx <hash>@<signer>)'] };
  let t: TxView;
  try {
    t = await txView(ref.hash, ref.signer);
  } catch (e) {
    return { ok: false, reasons: [`creation tx ${ref.hash} not readable here (old txs need an archival NEAR_RPC_URL): ${(e as Error).message.slice(0, 120)}`] };
  }
  if (t.transaction.signer_id !== parent || t.transaction.receiver_id !== shop) reasons.push(`creation tx ${ref.hash} is ${t.transaction.signer_id} -> ${t.transaction.receiver_id}, expected ${parent} -> ${shop}`);
  const kinds = t.transaction.actions.map(kind).join(',');
  if (kinds !== 'CreateAccount,Transfer,UseGlobalContract,FunctionCall') reasons.push(`creation actions are ${kinds}, expected CreateAccount,Transfer,UseGlobalContract,FunctionCall`);
  const use = (t.transaction.actions[2] as Exclude<TxAction, string> | undefined)?.UseGlobalContract;
  if (!use?.code_hash) reasons.push('code is not attached by an immutable code hash');
  const fc = (t.transaction.actions[3] as Exclude<TxAction, string> | undefined)?.FunctionCall;
  if (fc?.method_name !== 'new') reasons.push('the creation tx does not call new');
  if (!succeededAt(t, shop)) reasons.push('the creation tx or the vault receipt failed');
  const init = t.receipts_outcome
    .filter((r) => r.outcome.executor_id === shop)
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)) as { standard: string; event: string; data: Attestation['init'] })
    .find((e) => e.standard === 'secret_shopper' && e.event === 'initialized')?.data;
  if (!init) reasons.push('no initialized event from the vault in its creation tx');
  return { ok: reasons.length === 0, reasons, txHash: ref.hash, codeHash: use?.code_hash, init };
};

/** The vault's first incoming tx (its creation), via the FastNEAR Transactions API. */
const firstTxTo = async (accountId: string): Promise<{ hash: string; signer: string } | null> => {
  try {
    const res = await fetch(`${NEAR.txApiUrl}/v0/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, is_receiver: true, desc: false, limit: 1 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const row = ((await res.json()) as { account_txs: { transaction_hash: string; signer_id?: string }[] }).account_txs[0];
    if (!row) return null;
    return { hash: row.transaction_hash, signer: row.signer_id ?? accountId.slice(accountId.indexOf('.') + 1) };
  } catch {
    return null;
  }
};

const commitCallsIn = (txHash: string, signerId: string, actions: TxAction[]): CommitCall[] =>
  actions.flatMap((a) => {
    const fc = typeof a === 'object' ? a.FunctionCall : undefined;
    if (!fc || fc.method_name !== 'commit_batch') return [];
    const args = JSON.parse(Buffer.from(fc.args, 'base64').toString('utf8')) as { slots?: CommitSlotArg[]; ciphertexts?: string[] };
    return [{ txHash, signerId, slots: args.slots ?? [], ciphertexts: args.ciphertexts ?? [] }];
  });

/**
 * The commit_batch call(s) of one transaction, read from chain (archival RPC for old txs). With `expect`, the tx must
 * be a successful call to that vault signed by its owner (V21-04: ciphertexts in a failed or foreign tx prove nothing).
 */
export const commitCallFromTx = async (txHash: string, signerId: string, expect?: { shop: string; owner: string }): Promise<CommitCall[]> => {
  const t = await txView(txHash, signerId);
  if (expect) {
    if (t.transaction.receiver_id !== expect.shop) throw new Error(`commit tx ${txHash} is sent to ${t.transaction.receiver_id}, not ${expect.shop}`);
    if (t.transaction.signer_id !== expect.owner) throw new Error(`commit tx ${txHash} is signed by ${t.transaction.signer_id}, not the owner ${expect.owner}`);
    if (!succeededAt(t, expect.shop)) throw new Error(`commit tx ${txHash} failed`);
  }
  return commitCallsIn(txHash, signerId, t.transaction.actions);
};

const RETRYABLE = new Set([429, 502, 503, 504]);
const post = async <T>(path: string, body: unknown, attempts = 4): Promise<T> => {
  for (let i = 0; ; i++) {
    const res = await fetch(`${NEAR.txApiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (res.ok) return (await res.json()) as T;
    if (!RETRYABLE.has(res.status) || i + 1 >= attempts) throw new Error(`FastNEAR ${path} ${res.status}`);
    const after = Number(res.headers.get('retry-after'));
    await Bun.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** i);
  }
};

/** Every tx in which the vault received a receipt, oldest first (FastNEAR Transactions API). */
const receiverTxHashes = async (shop: string): Promise<string[]> => {
  const hashes: string[] = [];
  let resume: string | undefined;
  do {
    const page = await post<{ account_txs: { transaction_hash: string }[]; resume_token: string }>('/v0/account', {
      account_id: shop,
      is_receiver: true,
      desc: false,
      limit: 200,
      ...(resume ? { resume_token: resume } : {}),
    });
    hashes.push(...page.account_txs.map((t) => t.transaction_hash));
    resume = page.account_txs.length === 200 ? page.resume_token : undefined;
  } while (resume);
  return [...new Set(hashes)];
};

export type VaultEvent = { event: string; version: string; data: unknown; txHash: string; receiptId: string; blockHeight: number; blockTime: Date; logIndex: number };
type TxApiTx = {
  transaction: { hash: string };
  receipts?: { execution_outcome: { id: string; block_height: number; block_timestamp: number | string; outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } } }[];
};

/** NEP-297 events the vault logged in successful receipts; a failed receipt's logs describe reverted state. */
export const vaultEvents = async (shop: string, standard = 'secret_shopper'): Promise<VaultEvent[]> => {
  const hashes = await receiverTxHashes(shop);
  const out: VaultEvent[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const { transactions } = await post<{ transactions: TxApiTx[] }>('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) });
    for (const tx of transactions) {
      for (const { execution_outcome: eo } of tx.receipts ?? []) {
        if (eo.outcome.executor_id !== shop || !ok(eo.outcome.status)) continue;
        eo.outcome.logs.forEach((line, logIndex) => {
          if (!line.startsWith('EVENT_JSON:')) return;
          let ev: { standard?: string; version?: string; event?: string; data?: unknown };
          try {
            ev = JSON.parse(line.slice('EVENT_JSON:'.length));
          } catch {
            return;
          }
          if (ev.standard !== standard || typeof ev.event !== 'string') return;
          out.push({
            event: ev.event,
            version: String(ev.version ?? ''),
            data: Array.isArray(ev.data) ? ev.data[0] : ev.data,
            txHash: tx.transaction.hash,
            receiptId: eo.id,
            blockHeight: eo.block_height,
            blockTime: new Date(Number(BigInt(eo.block_timestamp) / 1_000_000n)),
            logIndex,
          });
        });
      }
    }
  }
  return out;
};

/** Discovers commit_batch txs to the vault through the FastNEAR Transactions API (testnet/mainnet, not the sandbox). */
export const discoverCommitCalls = async (shop: string, ownerId: string): Promise<CommitCall[]> => {
  const hashes = await receiverTxHashes(shop);
  const out: CommitCall[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const { transactions } = await post<{ transactions: { transaction: { hash: string; signer_id: string; receiver_id: string; actions: TxAction[] } }[] }>('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) });
    for (const { transaction: t } of transactions) {
      if (t.receiver_id === shop && t.signer_id === ownerId) out.push(...commitCallsIn(t.hash, t.signer_id, t.actions));
    }
  }
  return out;
};

/** Final block time in ms: expiry is judged by chain time (SS-B08). */
export const chainNowMs = async (): Promise<number> => {
  const b = await rpc<{ header: { timestamp_nanosec: string } }>('block', { finality: 'final' });
  return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
};
