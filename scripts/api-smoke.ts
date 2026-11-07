/**
 * Smoke test of the HTTP API the web app reads, against a running API and its live vault. Read-only: no tx is signed.
 * Public routes are checked against the chain; --owner also signs in with NEP-413 (the owner's key from
 * ~/.near-credentials, as a wallet would) and reads the owner routes. Never prints key material or the JWT.
 * --vendor signs in as the vault's vendor the same way and reads the vendor console.
 * Usage: bun api-smoke.ts [shop] [--owner] [--vendor]   (shop defaults to the API's /public/config)
 * Env: NEAR_NETWORK (default testnet), API_URL (default http://localhost:3700), WEB_ORIGIN (default http://localhost:3200).
 * Exit code = number of failed checks.
 */
import { NEAR, view } from './lib/net.ts';
import { loadLegacyKey } from './lib/creds.ts';
import { api, API_URL, signIn } from './lib/owner.ts';

const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3200';
let failed = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
};
const raw = (path: string, init: RequestInit = {}) => fetch(`${API_URL}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
const keysOf = (o: unknown): string[] => (o && typeof o === 'object' ? Object.keys(o).sort() : []);

type Config = { network: string; shop: string; owner: string; vendor: string; token: string };
type Slot = { slotIndex: number; commitment: string; status: string; expiresAt: string; revealed: boolean };
type Status = { mode: string; owner_id: string; version: string };
type Scorecard = { stats: Record<string, number | string> };

const health = await api<{ status: string }>('GET', '/health');
check(health.status === 200 && health.body.data.status === 'ok', 'GET /health');
const ready = await api<{ status: string; db: string }>('GET', '/ready');
check(ready.status === 200 && ready.body.data.db === 'ok', 'GET /ready reaches the database');

const config = await api<Config>('GET', '/public/config');
const shop = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : config.body.data.shop;
check(config.status === 200 && config.body.data.network === NEAR.network, 'GET /public/config names this network', `${config.body.data.network}, shop ${config.body.data.shop}`);

const chain = await view<Status>(shop, 'get_status');
const onChain = await view<Scorecard>(shop, 'get_scorecard');
const committed = Number(onChain.stats.committed);
const card = await api<{ mode: string; stats: Record<string, number | string>; pending: number; score_bps: number | null }>('GET', `/public/scorecard/${shop}`);
check(card.status === 200 && card.body.data.mode === chain.mode, 'scorecard mode equals the chain', card.body.data.mode);
check(JSON.stringify(card.body.data.stats) === JSON.stringify(onChain.stats), 'scorecard stats equal get_scorecard on chain', `committed ${committed}`);

const tests = await api<{ items: Slot[]; nextBefore: number | null }>('GET', `/public/tests/${shop}`);
const items = tests.body.data.items;
check(tests.status === 200 && items.length === committed, 'GET /public/tests lists every committed slot', `${items.length}`);
check(items.every((s, i) => i === 0 || s.slotIndex < items[i - 1].slotIndex), 'slots are newest first');
const hidden = items.filter((s) => !s.revealed);
check(hidden.every((s) => keysOf(s).join() === 'commitment,expiresAt,revealed,slotIndex,status'), 'unrevealed slots show only the commitment, never the lure', `${hidden.length} unrevealed`);
if (hidden.length) {
  const one = await raw(`/public/tests/${shop}/${hidden[0].slotIndex}`);
  check(one.status === 404, 'an unrevealed slot has no detail page', String(one.status));
}
if (items.length > 1) {
  const p1 = await api<{ items: Slot[]; nextBefore: number | null }>('GET', `/public/tests/${shop}?limit=1`);
  const p2 = await api<{ items: Slot[] }>('GET', `/public/tests/${shop}?limit=1&before=${p1.body.data.nextBefore}`);
  check(p1.body.data.items.length === 1 && p2.body.data.items[0]?.slotIndex === items[1].slotIndex, 'tests paging with limit and before');
}
const revealed = items.find((s) => s.revealed);
if (revealed) {
  const d = await raw(`/public/tests/${shop}/${revealed.slotIndex}`);
  check(d.status === 200, 'a revealed slot has a detail page', `slot ${revealed.slotIndex}`);
}

const ev = await api<{ shop: string; batches: { tx: string; signer_id: string }[]; slots: Record<string, unknown>[]; next_from_slot: number | null }>('GET', `/public/evidence/${shop}`);
check(ev.status === 200 && ev.body.data.shop === shop, 'GET /public/evidence names this vault');
check(ev.body.data.batches.every((b) => b.signer_id === chain.owner_id), 'every batch was signed by the owner', `${ev.body.data.batches.length} batches`);
check(ev.body.data.slots.filter((s) => s.status === 'Committed').every((s) => keysOf(s).join() === 'slot,status'), 'evidence carries no preimage before reveal');
check((await raw(`/public/evidence/${shop}?fromSlot=7`)).status === 400, 'evidence fromSlot must be a page boundary (400)');

const rel = await api<{ items: unknown[]; nextSince: string | null }>('GET', `/public/releases/${shop}`);
check(rel.status === 200 && Array.isArray(rel.body.data.items), 'GET /public/releases', `${rel.body.data.items.length} closed ticks`);
check((await raw(`/public/releases/${shop}?since=yesterday`)).status === 400, 'releases rejects a bad since (400)');

const ledger = await raw(`/public/ledger/${shop}`);
const csv = await ledger.text();
check(ledger.status === 200 && (ledger.headers.get('content-type') ?? '').startsWith('text/csv') && csv.replace(/^﻿/, '').startsWith('date_utc,type,status,invoice_id,payee,amount'), 'GET /public/ledger is CSV with the documented header');

check((await raw('/public/scorecard/nobody-here.testnet')).status === 404, 'unknown vault is 404');
check((await raw('/public/scorecard/BAD!')).status === 400, 'malformed account id is 400');
check((await raw(`/public/tests/${shop}?colour=red`)).status === 400, 'unknown query parameters are refused (400)');
check((await raw('/public/quote')).status === 400, 'quote without parameters is 400');
check((await raw('/no/such/route')).status === 404, 'unknown route is 404');

const pre = await raw(`/public/scorecard/${shop}`, { method: 'OPTIONS', headers: { origin: WEB_ORIGIN, 'access-control-request-method': 'GET' } });
check(pre.headers.get('access-control-allow-origin') === WEB_ORIGIN, `CORS allows the web origin ${WEB_ORIGIN}`);
const evil = await raw(`/public/scorecard/${shop}`, { headers: { origin: 'https://evil.example' } });
check(evil.headers.get('access-control-allow-origin') === null, 'CORS gives other origins nothing');
check(evil.headers.get('x-content-type-options') === 'nosniff' && evil.headers.get('x-frame-options') === 'DENY', 'security headers are set');

// self-serve vaults (read-only: a plan is built, never signed)
type ErrBody = { success: boolean; error: { code: string; fields?: { field: string }[]; vaultId?: string; codeHash?: string } };
const tpl = await api<{ codeHash: string; codePublished: boolean; planEnabled: boolean; defaultPolicy: Record<string, unknown> }>('GET', '/public/vault-template');
const live = await raw(`/public/vault/${shop}`);
const liveBody = (await live.json()) as { data: { codeHash: string; keys: { access_key: { permission: unknown } }[]; status: Status; scorecard: Scorecard } };
check(tpl.status === 200 && tpl.body.data.codePublished && tpl.body.data.codeHash === liveBody.data?.codeHash, 'vault template names the code this vault runs, published on chain', tpl.body.data.codeHash);
check(live.status === 200 && liveBody.data.status.mode === chain.mode && JSON.stringify(liveBody.data.scorecard.stats) === JSON.stringify(onChain.stats), 'GET /public/vault/:id equals the chain views');
check(liveBody.data.keys.length === 1 && !JSON.stringify(liveBody.data.keys[0].access_key.permission).includes('FullAccess'), 'the vault view shows one key and no full-access key');
const planBody = { ownerId: chain.owner_id, name: 'smoke-check', vendorId: config.body.data.vendor, fundNear: '1.5' };
const plan = await api<{ signerId: string; vaultId: string; codeHash: string; totalYocto: string; transactions: { receiverId: string; actions: { type: string; params?: { methodName?: string } }[] }[] }>('POST', '/public/vault-plan', planBody);
const t0 = plan.body.data?.transactions?.[0];
check(plan.status === 200 && plan.body.data.signerId === chain.owner_id && t0?.receiverId === `smoke-check.${chain.owner_id}`, 'POST /public/vault-plan builds a plan for <name>.<owner>', plan.body.data?.totalYocto);
check(t0?.actions.map((a) => a.type).join() === 'CreateAccount,Transfer,UseGlobalContract,FunctionCall' && t0.actions[3].params?.methodName === 'new', 'create, fund, attach code by hash and init are one transaction');
const same = await raw('/public/vault-plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...planBody, vendorId: chain.owner_id }) });
const sameBody = (await same.json()) as ErrBody;
check(same.status === 400 && sameBody.error.fields?.[0]?.field === 'vendorId', 'owner and vendor must differ (400, field vendorId)');
const dup = await raw('/public/vault-plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...planBody, name: shop.split('.')[0] }) });
const dupBody = (await dup.json()) as ErrBody;
check(dup.status === 409 && dupBody.error.vaultId === shop, 'an existing vault is refused (409)');
check((await raw('/public/vault/nobody-here-zz.testnet')).status === 404, 'a missing account is 404 on the vault view');
check((await raw(`/public/vault/${chain.owner_id}`)).status === 422, 'an account running other code is 422 on the vault view');

// measured model results and batch timing, from committed files and the chain
type Run = { lureKind: string; policy?: string; models: { trials: number; declined: number; paid: number }[] };
const runs = await api<{ runs: Run[]; b1: { accuracy: number; auc: number; n: number } | null }>('GET', '/public/model-runs');
// the strict-policy generated run: every model declined; the realistic run (a model paid a lure) is checked by its own counts
const gen = runs.body.data?.runs.find((r) => r.lureKind === 'generated' && (r.policy ?? 'strict') !== 'realistic');
const real = runs.body.data?.runs.find((r) => r.policy === 'realistic');
check(!real || real.models.reduce((n, m) => n + m.paid, 0) === 1, 'the realistic-policy run reports exactly the one paid lure in its file', String(real?.models.reduce((n, m) => n + m.paid, 0)));
check(runs.status === 200 && !!gen && gen.models.every((m) => m.declined === m.trials && m.paid === 0), 'GET /public/model-runs serves the measured runs', runs.body.data?.runs.map((r) => `${r.lureKind}:${r.models.length}`).join(', '));
check(runs.body.data?.b1?.n === 99 && runs.body.data.b1.accuracy === 0.586, 'model-runs carries the B1 blind test result', String(runs.body.data?.b1?.accuracy));
const sched = await api<{ nextReleaseAt: string; releaseTickMinutes: number; pending: number; lastBatch: { batchIndex: number } | null }>('GET', `/public/schedule/${shop}`);
const next = Date.parse(sched.body.data?.nextReleaseAt ?? '');
check(sched.status === 200 && next > Date.now() && next % (sched.body.data.releaseTickMinutes * 60_000) === 0, 'GET /public/schedule gives the next release tick on the grid', sched.body.data?.nextReleaseAt);
check(sched.body.data?.pending === Number(card.body.data.pending), 'schedule pending equals the scorecard', String(sched.body.data?.pending));
check(Object.keys(sched.body.data ?? {}).sort().join() === 'lastBatch,nextBatchEarliestAt,nextReleaseAt,nextRevealAfter,now,pending,releaseTickMinutes', 'schedule carries batch-level timing only');

// vendor console and alerts need a token
check((await raw('/vendor/me')).status === 401 && (await raw('/company/alerts')).status === 401, 'vendor console and alert feed need a token (401)');

check((await raw('/company/me')).status === 401, 'owner routes need a token (401)');
check((await raw('/company/me', { headers: { authorization: 'Bearer not-a-jwt' } })).status === 401, 'a forged token is refused (401)');

if (process.argv.includes('--owner')) {
  const token = await signIn(chain.owner_id, loadLegacyKey(NEAR.network, chain.owner_id));
  check(token.length > 0, 'NEP-413 sign-in as the vault owner', chain.owner_id);
  const me = await api<{ shopContractId: string }>('GET', '/company/me', undefined, token);
  check(me.status === 200 && me.body.data?.shopContractId === shop, 'GET /company/me is this vault');
  const vendors = await api<{ items: { legalName: string }[] }>('GET', '/vendors', undefined, token);
  check(vendors.status === 200 && vendors.body.data.items.length > 0, 'GET /vendors', vendors.body.data.items.map((v) => v.legalName).join(', '));
  const inv = await api<{ items: unknown[] }>('GET', '/invoices', undefined, token);
  check(inv.status === 200, 'GET /invoices', `${inv.body.data.items.length} items`);
  const own = await api<{ items: unknown[] }>('GET', '/tests', undefined, token);
  check(own.status === 200 && own.body.data.items.length === committed, 'GET /tests lists the owner\'s slots');
  const props = await api<{ items: unknown[] }>('GET', '/proposals', undefined, token);
  check(props.status === 200, 'GET /proposals', `${props.body.data.items.length} items`);
  const alerts = await api<{ items: { kind: string; text: string }[]; nextBefore: string | null }>('GET', '/company/alerts?limit=50', undefined, token);
  const kinds = new Set(alerts.body.data?.items.map((i) => i.kind));
  check(alerts.status === 200 && [...kinds].every((k) => ['armed', 'arming_failed', 'demoted', 'frozen', 'proposal', 'test_failed', 'declined'].includes(k)), 'GET /company/alerts lists alert-worthy events only', [...kinds].join(', '));
  const demotions = Number(onChain.stats.demotions);
  check(alerts.body.data.items.filter((i) => i.kind === 'demoted').length === demotions, 'the alert feed shows every demotion on chain', String(demotions));
  check((await api('GET', '/vendor/me', undefined, token)).status === 403, 'the owner is not the vendor (403 on /vendor/me)');
  const stranger = await api('POST', '/auth/verify', { accountId: chain.owner_id, publicKey: `ed25519:${'1'.repeat(44)}`, signature: 'AAAA', nonce: 'A'.repeat(43) + '=' });
  check(stranger.status === 401, 'sign-in with an unknown nonce is refused (401)');
}

if (process.argv.includes('--vendor')) {
  const vendorId = config.body.data.vendor;
  const token = await signIn(vendorId, loadLegacyKey(NEAR.network, vendorId));
  const vme = await api<{ vendorId: string; mode: string; agentKey: string | null; pendingKey: string | null; acceptKey: unknown; scorecard: Scorecard }>('GET', '/vendor/me', undefined, token);
  check(vme.status === 200 && vme.body.data.vendorId === vendorId && vme.body.data.mode === chain.mode, 'NEP-413 sign-in as the vendor; GET /vendor/me matches the chain', vme.body.data.mode);
  check(JSON.stringify(vme.body.data.scorecard.stats) === JSON.stringify(onChain.stats), 'the vendor sees the same scorecard as the chain');
  check((vme.body.data.pendingKey === null) === (vme.body.data.acceptKey === null), 'an accept_key call is offered only for a pending key');
  const hist = await api<{ items: { kind: string }[]; nextBefore: string | null }>('GET', '/vendor/history?limit=2', undefined, token);
  check(hist.status === 200 && hist.body.data.items.length > 0, 'GET /vendor/history', hist.body.data.items.map((i) => i.kind).join(', '));
  if (hist.body.data.nextBefore) {
    const next = await api<{ items: { id: string }[] }>('GET', `/vendor/history?limit=2&before=${hist.body.data.nextBefore}`, undefined, token);
    check(next.status === 200 && next.body.data.items.length > 0, 'vendor history pages by nextBefore');
  }
  check((await api('GET', '/company/alerts', undefined, token)).status === 403, 'the vendor cannot read the owner alert feed (403)');
}

console.log(failed === 0 ? `\nAPI SMOKE PASS against ${API_URL} (${shop})` : `\nAPI SMOKE FAIL: ${failed} check(s)`);
process.exit(failed);
