/**
 * `bun unit-cost.ts [vault]`: measured cost of running Secret Shopper on one vault, from public data only. Read-only.
 * Chain: every tx the vault took part in (FastNEAR Transactions API), tokens_burnt summed over the tx and all its
 * receipts; gas-key balances destroyed by DeleteKey and storage deltas read at the surrounding blocks (archival RPC).
 * Inference: usage of each published NEAR AI receipt in the evidence bundle, priced from GET /v1/model/list.
 * Prints markdown. NEAR is not converted to USD unless --near-usd is given; nothing fetches a NEAR price.
 *
 * Flags: --evidence <file> (default ../docs/evidence/<vault>.json), --near-usd <n>, --out <file>.
 * Env (optional): NEAR_NETWORK (testnet), NEAR_TX_API_URL, NEAR_ARCHIVAL_RPC_URL, NEARAI_BASE_URL.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { evidence: { type: 'string' }, 'near-usd': { type: 'string' }, out: { type: 'string' } },
  allowPositionals: true,
});
const VAULT = positionals[0] ?? 'shop4.ss-owner-e9c3db.testnet';
const NETWORK = process.env.NEAR_NETWORK || 'testnet';
if (NETWORK !== 'testnet' && NETWORK !== 'mainnet') throw new Error('NEAR_NETWORK must be testnet or mainnet');
const TX_API = process.env.NEAR_TX_API_URL || (NETWORK === 'mainnet' ? 'https://tx.main.fastnear.com' : 'https://tx.test.fastnear.com');
const RPC = process.env.NEAR_ARCHIVAL_RPC_URL || (NETWORK === 'mainnet' ? 'https://archival-rpc.mainnet.fastnear.com' : 'https://archival-rpc.testnet.fastnear.com');
const NEARAI = (process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/+$/, '');
const EXPLORER = NETWORK === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
const EVIDENCE = values.evidence ?? join(import.meta.dir, '..', 'docs', 'evidence', `${VAULT}.json`);
const NEAR_USD = values['near-usd'] === undefined ? null : Number(values['near-usd']);
if (NEAR_USD !== null && !(NEAR_USD > 0)) throw new Error('--near-usd must be a positive number');

const YOCTO = 10n ** 24n;
const near = (y: bigint): number => Number(y) / Number(YOCTO);
const fmtNear = (y: bigint): string => near(y).toFixed(6);
const fmtUsd = (usd: number): string => (usd === 0 ? '0' : usd < 0.01 ? usd.toFixed(5) : usd.toFixed(4));
const nearUsd = (y: bigint): string => (NEAR_USD === null ? 'n/a' : fmtUsd(near(y) * NEAR_USD));
const short = (h: string) => `[${h.slice(0, 8)}](${EXPLORER}/txns/${h})`;

const RETRYABLE = new Set([429, 502, 503, 504]);
const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as T;
    if (!RETRYABLE.has(res.status) || i >= 4) throw new Error(`${url} ${res.status}`);
    const after = Number(res.headers.get('retry-after'));
    await Bun.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** i);
  }
};
const txApi = <T>(path: string, body: unknown) => fetchJson<T>(`${TX_API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const rpc = async <T>(method: string, params: unknown): Promise<T> => {
  const j = await fetchJson<{ result?: T; error?: unknown }>(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (j.error || j.result === undefined) throw new Error(`rpc ${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
};
const viewCall = async <T>(method: string, blockId?: number): Promise<T> => {
  const r = await rpc<{ result: number[] }>('query', {
    request_type: 'call_function',
    account_id: VAULT,
    method_name: method,
    args_base64: Buffer.from('{}').toString('base64'),
    ...(blockId ? { block_id: blockId } : { finality: 'final' }),
  });
  return JSON.parse(Buffer.from(r.result).toString()) as T;
};
// heights can be skipped; walk down to the nearest produced block
const atOrBelow = async <T>(height: number, read: (h: number) => Promise<T>): Promise<T> => {
  for (let h = height, tries = 0; ; h--, tries++) {
    try {
      return await read(h);
    } catch (e) {
      if (tries >= 5) throw e;
    }
  }
};
const storageAt = (h: number) => atOrBelow(h, (b) => rpc<{ storage_usage: number }>('query', { request_type: 'view_account', block_id: b, account_id: VAULT })).then((a) => a.storage_usage);
type KeyView = { public_key: string; access_key: { permission: unknown } };
const gasKeyBalancesAt = async (h: number): Promise<{ pk: string; balance: bigint }[]> => {
  const r = await atOrBelow(h, (b) => rpc<{ keys: KeyView[] }>('query', { request_type: 'view_access_key_list', block_id: b, account_id: VAULT }));
  return r.keys.flatMap((k) => {
    const g = (k.access_key.permission as { GasKeyFunctionCall?: { balance: string } }).GasKeyFunctionCall;
    return g ? [{ pk: k.public_key, balance: BigInt(g.balance) }] : [];
  });
};

type Outcome = { executor_id: string; logs: string[]; status: Record<string, unknown>; gas_burnt: number; tokens_burnt: string };
type ApiTx = {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: (string | Record<string, { method_name?: string }>)[] };
  execution_outcome: { block_height: number; block_timestamp: number | string; outcome: Outcome };
  receipts?: { execution_outcome: { block_height: number; outcome: Outcome } }[];
};
type Ev = { event: string; data: Record<string, unknown> };
type Tx = { hash: string; signer: string; method: string; height: number; lastHeight: number; at: Date; burnt: bigint; gas: number; events: Ev[]; ok: boolean };

const success = (s: Record<string, unknown>) => 'SuccessValue' in s || 'SuccessReceiptId' in s;

const loadTxs = async (): Promise<Tx[]> => {
  const hashes: string[] = [];
  let resume: string | undefined;
  do {
    const page = await txApi<{ account_txs: { transaction_hash: string }[]; resume_token: string }>('/v0/account', { account_id: VAULT, desc: false, limit: 200, ...(resume ? { resume_token: resume } : {}) });
    hashes.push(...page.account_txs.map((t) => t.transaction_hash));
    resume = page.account_txs.length === 200 ? page.resume_token : undefined;
  } while (resume);
  const out: Tx[] = [];
  const unique = [...new Set(hashes)];
  for (let i = 0; i < unique.length; i += 20) {
    const { transactions } = await txApi<{ transactions: ApiTx[] }>('/v0/transactions', { tx_hashes: unique.slice(i, i + 20) });
    for (const t of transactions) {
      if (t.transaction.receiver_id !== VAULT) continue; // token-side txs are the payer's business, not the vault's
      const receipts = (t.receipts ?? []).map((r) => r.execution_outcome);
      const all = [t.execution_outcome.outcome, ...receipts.map((r) => r.outcome)];
      const vaultReceipts = receipts.filter((r) => r.outcome.executor_id === VAULT);
      const events = vaultReceipts
        .filter((r) => success(r.outcome.status))
        .flatMap((r) => r.outcome.logs)
        .filter((l) => l.startsWith('EVENT_JSON:'))
        .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)) as { standard: string; event: string; data: Record<string, unknown> })
        .filter((e) => e.standard === 'secret_shopper')
        .map((e) => ({ event: e.event, data: e.data }));
      const fc = t.transaction.actions.map((a) => (typeof a === 'string' ? a : a.FunctionCall?.method_name ?? Object.keys(a)[0]));
      out.push({
        hash: t.transaction.hash,
        signer: t.transaction.signer_id,
        method: fc.length === 1 ? fc[0] : fc.join('+'),
        height: t.execution_outcome.block_height,
        lastHeight: Math.max(t.execution_outcome.block_height, ...receipts.map((r) => r.block_height)),
        at: new Date(Number(BigInt(t.execution_outcome.block_timestamp) / 1_000_000n)),
        burnt: all.reduce((s, o) => s + BigInt(o.tokens_burnt), 0n),
        gas: all.reduce((s, o) => s + o.gas_burnt, 0),
        events,
        ok: vaultReceipts.length > 0 && vaultReceipts.every((r) => success(r.outcome.status)),
      });
    }
  }
  return out.sort((a, b) => a.height - b.height);
};

type Price = { amount: number; scale: number };
type Model = { modelId: string; inputCostPerToken: Price; outputCostPerToken: Price; cacheReadCostPerToken?: Price };
const perToken = (p: Price | undefined): number | null => (p ? p.amount / 10 ** p.scale : null);

type Usage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } | null; reasoning_tokens?: number };
type EvidenceSlot = { slot: number; status: string; invoice?: { deliver_at: string }; receipt?: { model: string; response_body: string }; reveal_tx: string | null };
type Evidence = { shop: string; batches: { batch: number; first_slot: number; count: number; tx: string; gen_log: { model: string; accepted: boolean }[] }[]; slots: EvidenceSlot[]; next_from_slot: number | null };

const mean = (xs: bigint[]): bigint => (xs.length ? xs.reduce((s, x) => s + x, 0n) / BigInt(xs.length) : 0n);
const sum = (xs: bigint[]): bigint => xs.reduce((s, x) => s + x, 0n);

const main = async () => {
  const [txs, policy, account, protocol, gasPriceNow, evidence, models] = await Promise.all([
    loadTxs(),
    viewCall<{ batch_size: number; batch_interval: string; key_allowance: string; key_nonces: number; min_near_float: string }>('get_policy'),
    rpc<{ storage_usage: number; amount: string; block_height: number }>('query', { request_type: 'view_account', finality: 'final', account_id: VAULT }),
    rpc<{ runtime_config: { storage_amount_per_byte: string } }>('EXPERIMENTAL_protocol_config', { finality: 'final' }),
    rpc<{ gas_price: string }>('gas_price', [null]).then((r) => BigInt(r.gas_price)),
    Promise.resolve(JSON.parse(readFileSync(EVIDENCE, 'utf8')) as Evidence),
    fetchJson<{ models: Model[] }>(`${NEARAI}/model/list?limit=1000`).then(
      (r) => r.models,
      (e: Error) => {
        process.stderr.write(`model prices unavailable: ${e.message}\n`);
        return [] as Model[];
      }
    ),
  ]);
  if (evidence.shop !== VAULT) throw new Error(`evidence ${EVIDENCE} is for ${evidence.shop}, not ${VAULT}`);
  const okTxs = txs.filter((t) => t.ok);
  const by = (m: string) => okTxs.filter((t) => t.method === m);
  const perByte = BigInt(protocol.runtime_config.storage_amount_per_byte);

  // DeleteKey of a funded gas key burns its balance in the same receipt; read it one block before the tx
  const keyBurn = new Map<string, bigint>();
  for (const t of okTxs.filter((x) => x.events.some((e) => e.event === 'agent_demoted' || e.event === 'agent_armed'))) {
    const before = await gasKeyBalancesAt(t.height - 1);
    keyBurn.set(t.hash, sum(before.map((k) => k.balance)));
  }
  const gasOnly = (t: Tx) => t.burnt - (keyBurn.get(t.hash) ?? 0n);

  // storage each commit and reveal leaves behind
  const storageDelta = new Map<string, number>();
  for (const t of [...by('commit_batch'), ...by('reveal')]) {
    const [pre, post] = await Promise.all([storageAt(t.height - 1), storageAt(t.lastHeight + 1)]);
    storageDelta.set(t.hash, post - pre);
  }

  const releases = by('release').map((t) => ({ t, ev: t.events.find((e) => e.event === 'release_posted')!.data as { release_at: string; count: number } }));
  const acks = by('ack').map((t) => ({ t, ev: t.events.find((e) => e.event === 'release_acked')!.data as { release_at: string; matches: boolean } }));
  const reveals = by('reveal').map((t) => ({ t, ev: t.events.find((e) => e.event === 'test_revealed')!.data as { slot_id: number; status: string } }));
  const commits = by('commit_batch').map((t) => ({ t, ev: t.events.find((e) => e.event === 'batch_committed')!.data as { batch: number; first_slot: number; count: number } }));
  const decisions = okTxs.filter((t) => ['pay', 'decline', 'propose'].includes(t.method));

  // inference per lure: published receipts only
  const priceOf = new Map(models.map((m) => [m.modelId, m]));
  type Gen = { slot: number; model: string; usage: Usage; usd: number | null };
  const gens: Gen[] = evidence.slots.flatMap((s) => {
    if (!s.receipt) return [];
    const usage = (JSON.parse(s.receipt.response_body) as { usage: Usage }).usage;
    const m = priceOf.get(s.receipt.model);
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const [inP, outP, cacheP] = [perToken(m?.inputCostPerToken), perToken(m?.outputCostPerToken), perToken(m?.cacheReadCostPerToken) ?? perToken(m?.inputCostPerToken)];
    const usd = inP === null || outP === null || cacheP === null ? null : (usage.prompt_tokens - cached) * inP + cached * cacheP + usage.completion_tokens * outP;
    return [{ slot: s.slot, model: s.receipt.model, usage, usd }];
  });
  const genUsd = gens.every((g) => g.usd !== null) && gens.length ? gens.reduce((s, g) => s + g.usd!, 0) / gens.length : null;
  const rejectedDrafts = evidence.batches.flatMap((b) => b.gen_log).filter((g) => !g.accepted).length;

  // per slot: commit share + release share (its tick) + reveal
  type SlotCost = { slot: number; status: string; commit: bigint; release: bigint | null; releaseTx: string | null; reveal: bigint; revealTx: string; storage: number };
  const slotCosts: SlotCost[] = reveals.map(({ t, ev }) => {
    const c = commits.find((x) => ev.slot_id >= x.ev.first_slot && ev.slot_id < x.ev.first_slot + x.ev.count)!;
    const es = evidence.slots.find((s) => s.slot === ev.slot_id);
    const at = es?.invoice ? (BigInt(Date.parse(es.invoice.deliver_at)) * 1_000_000n).toString() : null;
    const rel = at ? releases.find((r) => r.ev.release_at === at) : undefined;
    return {
      slot: ev.slot_id,
      status: ev.status,
      commit: c.t.burnt / BigInt(c.ev.count),
      release: rel ? rel.t.burnt / BigInt(rel.ev.count) : null,
      releaseTx: rel?.t.hash ?? null,
      reveal: gasOnly(t),
      revealTx: t.hash,
      storage: (storageDelta.get(c.t.hash) ?? 0) / c.ev.count + (storageDelta.get(t.hash) ?? 0),
    };
  });
  const lureCosts = slotCosts.filter((s) => s.release !== null);
  const meanLure = mean(lureCosts.map((s) => s.commit + s.release! + s.reveal));
  const meanVoid = mean(slotCosts.filter((s) => s.release === null).map((s) => s.commit + s.reveal));
  const meanCommit = mean(commits.map((c) => c.t.burnt));
  const meanRelease = mean(releases.map((r) => r.t.burnt));
  const meanRevealPassed = mean(reveals.filter((r) => r.ev.status !== 'Failed').map((r) => r.t.burnt));
  const meanStorageSlot = slotCosts.reduce((s, x) => s + x.storage, 0) / Math.max(1, slotCosts.length);

  // per failure: the Failed reveal (gas and the armed key's burn) and the re-arm (propose_key, accept_key and the demoted key's burn)
  const failed = reveals.filter((r) => r.ev.status === 'Failed');
  const rearms = by('accept_key').filter((t) => keyBurn.has(t.hash) && (keyBurn.get(t.hash) ?? 0n) > 0n);
  const failure = failed[0]
    ? (() => {
        const f = failed[0].t;
        const re = rearms.find((t) => t.height > f.height);
        const pk = re ? by('propose_key').filter((t) => t.height < re.height).at(-1) : undefined;
        return { f, re, pk };
      })()
    : null;

  const ackedItems = sum(acks.map((a) => BigInt(releases.find((r) => r.ev.release_at === a.ev.release_at)?.ev.count ?? 0)));
  const ackPerItem = ackedItems > 0n ? sum(acks.map((a) => a.t.burnt)) / ackedItems : 0n;
  const meanDecision = mean(decisions.map((t) => t.burnt));
  const meanAck = mean(acks.map((a) => a.t.burnt));

  const batchesPerDayPolicy = Math.floor((86_400 * 1e9) / Number(policy.batch_interval));
  const L: string[] = [];
  const p = (s = '') => L.push(s);
  const row = (cells: (string | number)[]) => p(`| ${cells.join(' | ')} |`);

  p(`Vault \`${VAULT}\` (${NETWORK}), read ${new Date().toISOString()} at block ${account.block_height}. ${okTxs.length} successful txs to the vault (${txs.length - okTxs.length} failed, excluded). Gas price now ${gasPriceNow} yocto/gas (${fmtNear(gasPriceNow * 10n ** 12n)} NEAR per Tgas, \`gas_price\` RPC); the costs below are the tokens_burnt recorded at the time. NEAR in USD: ${NEAR_USD === null ? 'not given (pass --near-usd)' : `${NEAR_USD} (from --near-usd)`}.`);
  p();
  p('### Cost per transaction type');
  p();
  p('tokens_burnt summed over the tx and every receipt. Payer: the account whose NEAR pays (agent txs burn the gas key balance, which the vault funded).');
  p();
  row(['Tx', 'Signed by', 'Count', 'Mean NEAR', 'Min', 'Max', 'Mean USD', 'Txs']);
  row([':-', ':-', '-:', '-:', '-:', '-:', '-:', ':-']);
  const methods = ['commit_batch', 'release', 'reveal', 'prove_delivery', 'ack', 'decline', 'pay', 'propose', 'approve', 'propose_key', 'accept_key'];
  for (const m of methods) {
    const xs = by(m).map((t) => ({ t, g: gasOnly(t) }));
    const signer = m === 'accept_key' ? 'vendor' : ['ack', 'decline', 'pay', 'propose'].includes(m) ? 'agent gas key' : m === 'approve' || m === 'propose_key' ? 'owner' : 'owner (tester FC key)';
    if (!xs.length) {
      row([`\`${m}\``, signer, 0, 'none on this vault', '', '', '', '']);
      continue;
    }
    const g = xs.map((x) => x.g);
    const burned = xs.some((x) => keyBurn.get(x.t.hash));
    row([`\`${m}\`${burned ? ' (gas only)' : ''}`, signer, xs.length, fmtNear(mean(g)), fmtNear(g.reduce((a, b) => (b < a ? b : a))), fmtNear(g.reduce((a, b) => (b > a ? b : a))), nearUsd(mean(g)), xs.map((x) => short(x.t.hash)).join(' ')]);
  }
  p();
  p(`Reveals by outcome: passed or void ${fmtNear(meanRevealPassed)} NEAR mean; Failed ${failed.map((r) => `${fmtNear(gasOnly(r.t))} NEAR gas plus ${fmtNear(keyBurn.get(r.t.hash) ?? 0n)} NEAR of gas-key balance destroyed by DeleteKey (${short(r.t.hash)})`).join('; ') || 'none'}.`);
  p();
  p('### Gas-key balance destroyed by DeleteKey');
  p();
  p(`A demotion and a re-arm each delete the agent's gas key; its unspent balance is burned in that receipt. Balance read with \`view_access_key_list\` one block before the tx. Each new key is funded with \`key_allowance\` = ${fmtNear(BigInt(policy.key_allowance))} NEAR from the vault.`);
  p();
  row(['Tx', 'Event', 'Key balance destroyed (NEAR)', 'Total tokens_burnt (NEAR)', 'Of which gas']);
  row([':-', ':-', '-:', '-:', '-:']);
  for (const t of okTxs.filter((x) => keyBurn.has(x.hash))) {
    row([short(t.hash), `${t.method}: ${t.events.map((e) => e.event).filter((e) => e.startsWith('agent_')).join(', ')}`, fmtNear(keyBurn.get(t.hash)!), fmtNear(t.burnt), fmtNear(gasOnly(t))]);
  }
  p();
  p('### Storage');
  p();
  p(`The vault holds ${account.storage_usage} bytes now, staking ${fmtNear(BigInt(account.storage_usage) * perByte)} NEAR at ${fmtNear(perByte * 1000n)} NEAR per KB (protocol \`storage_amount_per_byte\`). Staked, not burned: it stays locked in the vault. Policy reserve \`min_near_float\` ${fmtNear(BigInt(policy.min_near_float))} NEAR on top.`);
  p();
  row(['Tx', 'Bytes added']);
  row([':-', '-:']);
  for (const [h, d] of storageDelta) row([`${short(h)} ${okTxs.find((t) => t.hash === h)!.method}`, d]);
  p();
  p(`Mean storage per slot (commit share + its reveal): ${meanStorageSlot.toFixed(0)} bytes, ${fmtNear(BigInt(Math.round(meanStorageSlot)) * perByte)} NEAR staked.`);
  p();
  p('### Lure generation (NEAR AI)');
  p();
  p(`Usage from the \`usage\` field of each published receipt in \`${EVIDENCE.replace(/^.*\/docs\//, 'docs/')}\`; prices from \`GET ${NEARAI}/model/list\` (${models.length ? 'nano-USD per token at scale 9' : 'unavailable this run'}). Cached prompt tokens at the cache-read price.`);
  p();
  row(['Slot', 'Model', 'Prompt', 'Cached', 'Completion', 'Of which reasoning', 'USD']);
  row(['-:', ':-', '-:', '-:', '-:', '-:', '-:']);
  for (const g of gens) row([g.slot, g.model, g.usage.prompt_tokens, g.usage.prompt_tokens_details?.cached_tokens ?? 0, g.usage.completion_tokens, g.usage.reasoning_tokens ?? 0, g.usd === null ? 'price unknown' : fmtUsd(g.usd)]);
  for (const m of [...new Set(gens.map((g) => g.model))]) {
    const pr = priceOf.get(m);
    if (pr) p(`\n${m}: input ${(perToken(pr.inputCostPerToken)! * 1e6).toFixed(3)}, output ${(perToken(pr.outputCostPerToken)! * 1e6).toFixed(3)}, cache read ${((perToken(pr.cacheReadCostPerToken) ?? 0) * 1e6).toFixed(3)} USD per million tokens.`);
  }
  p();
  p(`Mean per lure: ${genUsd === null ? 'unknown' : `${fmtUsd(genUsd)} USD`}. Drafts the tester rejected are not published, so their calls are not counted (the bundle's gen_log lists ${rejectedDrafts} rejected).`);
  p();
  p('### Per slot');
  p();
  p('Commit share = commit_batch / batch size; release share = the release tx of the tick that delivered the lure / items released in that tick (a void is never delivered); reveal = gas only.');
  p();
  row(['Slot', 'Status', 'Commit share', 'Release share', 'Reveal', 'Total NEAR', 'Total USD', 'Release tx', 'Reveal tx']);
  row(['-:', ':-', '-:', '-:', '-:', '-:', '-:', ':-', ':-']);
  for (const s of slotCosts) {
    const total = s.commit + (s.release ?? 0n) + s.reveal;
    row([s.slot, s.status, fmtNear(s.commit), s.release === null ? 'n/a' : fmtNear(s.release), fmtNear(s.reveal), fmtNear(total), nearUsd(total), s.releaseTx ? short(s.releaseTx) : '', short(s.revealTx)]);
  }
  p();
  p('### Summary');
  p();
  const lureUsd = (y: bigint) => (NEAR_USD === null || genUsd === null ? 'n/a' : fmtUsd(near(y) * NEAR_USD + genUsd));
  row(['Unit', 'Chain NEAR (burned)', 'Inference USD', 'Total USD', 'How']);
  row([':-', '-:', '-:', '-:', ':-']);
  row(['Test slot, lure', fmtNear(meanLure), genUsd === null ? 'unknown' : fmtUsd(genUsd), lureUsd(meanLure), `mean of ${lureCosts.length} delivered slots above`]);
  row(['Test slot, void', fmtNear(meanVoid), '0', nearUsd(meanVoid), 'commit share + reveal']);
  const batchNear = meanCommit + BigInt(policy.batch_size) * (meanRelease + meanRevealPassed);
  const batchUsd = genUsd === null ? null : genUsd * policy.batch_size;
  row([`Batch (${policy.batch_size} lures)`, fmtNear(batchNear), batchUsd === null ? 'unknown' : fmtUsd(batchUsd), NEAR_USD === null || batchUsd === null ? 'n/a' : fmtUsd(near(batchNear) * NEAR_USD + batchUsd), `commit ${fmtNear(meanCommit)} + ${policy.batch_size} x (whole release ${fmtNear(meanRelease)} + reveal ${fmtNear(meanRevealPassed)}); upper bound, a release shared with real invoices costs the lure less`]);
  for (const [label, n] of [
    ['Day, tester default (TESTER_COMMIT_CRON 0 0 * * *, one commit a day)', 1],
    [`Day, policy maximum (one batch every ${Number(policy.batch_interval) / 3.6e12} h)`, batchesPerDayPolicy],
  ] as const) {
    const d = BigInt(n) * batchNear;
    const u = batchUsd === null ? null : batchUsd * n;
    row([label, fmtNear(d), u === null ? 'unknown' : fmtUsd(u), NEAR_USD === null || u === null ? 'n/a' : fmtUsd(near(d) * NEAR_USD + u), `${n} batch${n > 1 ? 'es' : ''} of ${policy.batch_size}`]);
  }
  if (failure) {
    const parts = [gasOnly(failure.f), keyBurn.get(failure.f.hash) ?? 0n, failure.pk ? failure.pk.burnt : 0n, failure.re ? gasOnly(failure.re) : 0n, failure.re ? keyBurn.get(failure.re.hash) ?? 0n : 0n];
    const total = sum(parts);
    row([
      'Failure (demotion + re-arm)',
      fmtNear(total),
      '0',
      nearUsd(total),
      `Failed reveal gas ${fmtNear(parts[0])} (${short(failure.f.hash)}) + armed key destroyed ${fmtNear(parts[1])} + propose_key ${fmtNear(parts[2])}${failure.pk ? ` (${short(failure.pk.hash)})` : ''} + accept_key gas ${fmtNear(parts[3])}${failure.re ? ` (${short(failure.re.hash)})` : ''} + demoted key destroyed ${fmtNear(parts[4])}`,
    ]);
  }
  const setup = okTxs.filter((t) => t.events.some((e) => e.event === 'initialized'));
  const firstArm = by('accept_key').find((t) => !keyBurn.get(t.hash));
  const firstPropose = firstArm ? by('propose_key').filter((t) => t.height < firstArm.height).at(-1) : undefined;
  const setupTxs = [...setup, ...(firstPropose ? [firstPropose] : []), ...(firstArm ? [firstArm] : [])];
  if (setupTxs.length) {
    const s = sum(setupTxs.map((t) => t.burnt));
    row(['Vault setup (once)', fmtNear(s), '0', nearUsd(s), `${setupTxs.map((t) => `${t.method} ${fmtNear(t.burnt)} (${short(t.hash)})`).join(' + ')}; plus the NEAR the owner deposits (the vault's balance, storage and float)`]);
  }
  row(['Agent decision', fmtNear(meanDecision + ackPerItem), '0 (model is the vendor\'s)', nearUsd(meanDecision + ackPerItem), `decision tx ${fmtNear(meanDecision)} (mean of ${decisions.length} pay, decline, propose) + ack share ${fmtNear(ackPerItem)} (${acks.length} acks ${fmtNear(meanAck)} each over ${ackedItems} items)`]);
  p();
  p('Not in these figures: storage staked (locked, not burned, above), the vault\'s own NEAR float, the agent\'s model calls (the vendor\'s), the owner\'s wallet txs other than the ones listed, and drafts the tester rejected.');

  const md = L.join('\n') + '\n';
  if (values.out) writeFileSync(values.out, md);
  process.stdout.write(md);
};

await main();
