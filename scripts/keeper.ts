/**
 * Keeper (B8): reveals Secret Shopper slots without the owner. Reads each slot's tlock ciphertext from the commit tx
 * args, checks its sha256 against the chain, waits for the drand quicknet round, decrypts, checks the commitment,
 * and calls the permissionless `reveal` from any account. No backend, database or seal key.
 *
 * Usage: bun keeper.ts <shop> [--commit-tx <hash>@<signer> ...] [--once] [--interval-s N]
 *   Without --commit-tx, commit txs are discovered with the FastNEAR Transactions API (testnet/mainnet).
 * Env: NEAR_NETWORK, NEAR_RPC_URL, KEEPER_ACCOUNT_ID (any funded account; pays reveal gas) and either
 *      KEEPER_PRIVATE_KEY or its key in the legacy keychain ~/.near-credentials/<network>/<account>.json.
 * Exit code: 0, or 1 if a ciphertext fails its hash, will not open, or opens to a wrong preimage (owner sabotage).
 */
import { Account, getTransactionLastResult, teraToGas, type KeyPairString } from 'near-api-js';
import { NEAR, provider, req, view } from './lib/net.ts';
import { chainNowMs, commitCallFromTx, discoverCommitCalls, type CommitCall } from './lib/chainread.ts';
import { ciphertextSha256, drandRoundAt, drandRoundTimeMs, DrandUnavailable, openFromChain } from '../backend/src/lib/proof/tlock.ts';
import { loadLegacyKey } from './lib/creds.ts';
import { commitmentOf } from '../backend/src/lib/proof/commitment.ts';

type Slot = { commitment: string; expires_at: string; tlock_round: number; ciphertext_sha256: string; status: string };

const shop = process.argv[2];
if (!shop || shop.startsWith('--')) {
  console.error('usage: bun keeper.ts <shop> [--commit-tx <hash>@<signer> ...] [--once]');
  process.exit(2);
}
const once = process.argv.includes('--once');
const txArgs = process.argv.flatMap((a, i) => (a === '--commit-tx' ? [process.argv[i + 1]] : []));
const keeperId = req('KEEPER_ACCOUNT_ID');
// never take the key from argv (visible in ps); env or the user's keychain only
const keeper = new Account(keeperId, provider, (process.env.KEEPER_PRIVATE_KEY || loadLegacyKey(NEAR.network, keeperId)) as KeyPairString);
const intervalArg = process.argv.indexOf('--interval-s');
const INTERVAL_MS = (intervalArg > 0 ? Number(process.argv[intervalArg + 1]) : 60) * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const log = (msg: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), component: 'keeper', msg, ...f }));

const allTests = async (): Promise<Slot[]> => {
  const out: Slot[] = [];
  for (;;) {
    const page = await view<Slot[]>(shop, 'get_tests', { from: out.length, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
};

const known = new Map<string, string>(); // commitment -> ciphertext, kept across passes
const scheduled = new Set<number>();

const loadCommits = async (): Promise<Map<string, string>> => {
  let calls: CommitCall[] = [];
  if (txArgs.length) {
    for (const t of txArgs) {
      const [hash, signer] = t.split('@');
      calls.push(...(await commitCallFromTx(hash, signer)));
    }
  } else {
    const owner = (await view<{ owner_id: string }>(shop, 'get_status')).owner_id;
    calls = await discoverCommitCalls(shop, owner);
  }
  // commitment -> ciphertext (base64), from tx args only
  for (const c of calls) {
    c.slots.forEach((s, i) => c.ciphertexts[i] && known.set(s.commitment, c.ciphertexts[i]));
    if (calls.length) log('commit tx found', { tx: c.txHash, signer: c.signerId, slots: c.slots.length, source: txArgs.length ? '--commit-tx' : 'FastNEAR tx API' });
  }
  return known;
};

const pass = async (): Promise<{ revealed: number; waiting: number; sabotaged: number }> => {
  const [slots, now] = await Promise.all([allTests(), chainNowMs()]);
  // rediscover only when a committed slot has no ciphertext yet (keeps FastNEAR load low on long runs)
  const cts = slots.some((s) => s.status === 'Committed' && !known.has(s.commitment)) ? await loadCommits() : known;
  const round = drandRoundAt(Date.now());
  let revealed = 0;
  let waiting = 0;
  let sabotaged = 0;
  for (const [slotId, s] of slots.entries()) {
    if (s.status !== 'Committed') continue;
    const ct = cts.get(s.commitment);
    if (!ct) {
      log('no ciphertext for slot in the known commit txs', { slotId });
      waiting++;
      continue;
    }
    if (ciphertextSha256(ct) !== s.ciphertext_sha256) {
      log('OWNER SABOTAGE: ciphertext does not match the on-chain sha256', { slotId });
      sabotaged++;
      continue;
    }
    if (!scheduled.has(slotId)) {
      scheduled.add(slotId);
      const opensAt = drandRoundTimeMs(s.tlock_round);
      const expiresAt = Number(BigInt(s.expires_at) / 1_000_000n);
      log('scheduled', { slotId, expires_at: iso(expiresAt), tlock_round: s.tlock_round, round_published_at: iso(opensAt), reveal_after: iso(Math.max(opensAt, expiresAt)) });
    }
    if (round < s.tlock_round) {
      waiting++;
      continue;
    }
    let p;
    try {
      p = await openFromChain(ct);
    } catch (e) {
      if (e instanceof DrandUnavailable) {
        log('drand unreachable, will retry', { slotId, error: e.message.slice(0, 200) });
        waiting++;
        continue;
      }
      log('OWNER SABOTAGE: ciphertext does not open', { slotId, error: (e as Error).message });
      sabotaged++;
      continue;
    }
    if (commitmentOf(p.salt, p.payee, p.invoice_id, p.receipt_hash) !== s.commitment) {
      log('OWNER SABOTAGE: preimage does not match the commitment', { slotId });
      sabotaged++;
      continue;
    }
    // unpaid tests and voids only reveal after expiry, judged by chain time; a touched test can go at once
    const touched = p.payee ? await view<unknown>(shop, 'get_payee', { account_id: p.payee }) : null;
    if (!touched && now < Number(BigInt(s.expires_at) / 1_000_000n)) {
      waiting++;
      continue;
    }
    try {
      const out = await keeper.callFunctionRaw({
        contractId: shop,
        methodName: 'reveal',
        args: { slot_id: slotId, salt: p.salt, payee: p.payee, invoice_id: p.invoice_id, receipt_hash: p.receipt_hash },
        gas: teraToGas(100),
        deposit: 0n,
        waitUntil: 'FINAL',
      });
      log('revealed', { slotId, status: String(getTransactionLastResult(out)), tx: out.transaction.hash, by: keeper.accountId });
      revealed++;
    } catch (e) {
      log('reveal rejected', { slotId, error: (e as Error).message.slice(0, 300) });
      waiting++;
    }
  }
  return { revealed, waiting, sabotaged };
};

log('started', { shop, keeper: keeperId, network: NEAR.network, interval_s: INTERVAL_MS / 1000, once });
let last = '';
let lastBeat = 0;
for (;;) {
  try {
    const r = await pass();
    const sig = JSON.stringify(r);
    // log changes and an hourly heartbeat, not every pass
    if (sig !== last || Date.now() - lastBeat > 3_600_000) {
      log('pass done', r);
      last = sig;
      lastBeat = Date.now();
    }
    if (r.sabotaged > 0) process.exit(1);
  } catch (e) {
    log('pass failed', { error: (e as Error).message.slice(0, 300) });
    if (once) process.exit(2);
  }
  if (once) process.exit(0);
  await Bun.sleep(INTERVAL_MS);
}
