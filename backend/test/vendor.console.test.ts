import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import jwt from 'jsonwebtoken';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Policy, Scorecard, Status } from '../src/lib/near/shop.ts';
import { ACCEPT_KEY_GAS, dateToNs, VENDOR_EVENTS, vendorView } from '../src/lib/vendorView.ts';
import { assertTestDatabase } from './dbGuard.ts';

const ROOT = resolve(import.meta.dir, '..');
const VAULT = 'shop4.ss-owner-e9c3db.testnet';
const PENDING = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

const status = (over: Partial<Status> = {}): Status => ({
  mode: 'Unarmed',
  agent_key: null,
  pending_key: null,
  armed_at: '0',
  demoted_at: '0',
  spent_24h: '0',
  version: '2.3.0',
  owner_id: 'owner.testnet',
  vendor_id: 'vendor.testnet',
  token_id: 'tusdc.testnet',
  intents_id: null,
  stale_key: null,
  ...over,
});
const policy: Policy = {
  daily_cap: '50000000',
  max_per_payment: '5000000',
  max_new_payees_per_day: 2,
  max_payments_per_day: 10,
  max_decisions_per_day: 40,
  batch_size: 4,
  batch_interval: '3600000000000',
  test_ttl: '86400000000000',
  reveal_grace: '600000000000',
  rearm_cooldown: '86400000000000',
  payee_delay: '3600000000000',
  limits_delay: '86400000000000',
  key_allowance: '250000000000000000000000',
  key_nonces: 4,
  storage_deposit: '1250000000000000000000',
  min_near_float: '1000000000000000000000000',
  min_answer: '21600000000000',
};
const scorecard = {
  mode: 'Unarmed',
  agent_key: null,
  stats: { committed: 0, passed: 0, failed: 0, failed_contained: 0, unanswered: 0, void: 0, invalid: 0, payments: 0, paid_total: '0', declines: 0, proposals: 0, demotions: 0 },
  score_bps: null,
  pending: 0,
  overdue_unrevealed: 0,
  spent_24h: '0',
  now: '1',
} as Scorecard;

describe('vendorView', () => {
  test('a pending key comes with the exact accept_key call for the wallet', () => {
    const v = vendorView(VAULT, 'testnet', status({ pending_key: PENDING }), policy, scorecard, { pendingKeyProposedAt: '1794394404795000000', lastArmedKey: PENDING });
    expect(v.pendingKeyProposedAt).toBe('1794394404795000000');
    expect(v.pendingKeyMatchesArmed).toBe(true);
    expect(v.cooldownEndsAt).toBeNull();
    expect(v.acceptKey).toEqual({ receiverId: VAULT, methodName: 'accept_key', args: { public_key: PENDING }, gas: ACCEPT_KEY_GAS, deposit: '1' });
    expect(ACCEPT_KEY_GAS).toBe('30000000000000');
    expect(v).toMatchObject({ vault: VAULT, network: 'testnet', vendorId: 'vendor.testnet', ownerId: 'owner.testnet', mode: 'Unarmed', pendingKey: PENDING, staleKey: null });
    expect(v.scorecard).toBe(scorecard);
  });

  test('no pending key, no call; limits carry only the summary fields', () => {
    const v = vendorView(VAULT, 'testnet', status({ mode: 'Armed', agent_key: PENDING, armed_at: '5' }), { ...policy, key_nonces: undefined }, scorecard);
    expect(v.acceptKey).toBeNull();
    expect(v.pendingKeyProposedAt).toBeNull();
    expect(v.armedAt).toBe('5');
    expect(v.limits).toEqual({
      max_per_payment: '5000000',
      daily_cap: '50000000',
      max_payments_per_day: 10,
      max_decisions_per_day: 40,
      max_new_payees_per_day: 2,
      rearm_cooldown: '86400000000000',
      key_nonces: 0,
      key_allowance: '250000000000000000000000',
    });
  });

  test('cooldownEndsAt is demoted_at plus rearm_cooldown, exact in ns', () => {
    const v = vendorView(VAULT, 'testnet', status({ mode: 'Demoted', demoted_at: '1794394404795374071' }), policy, scorecard, { pendingKeyProposedAt: '1', lastArmedKey: PENDING });
    expect(v.cooldownEndsAt).toBe('1794480804795374071');
    expect(v.pendingKeyProposedAt).toBeNull();
    expect(v.pendingKeyMatchesArmed).toBeNull();
    expect(dateToNs(new Date(1794394404795))).toBe('1794394404795000000');
  });

  test('a pending key the vendor never armed, or another than the last armed, does not match (NF-06)', () => {
    const s = status({ pending_key: PENDING });
    expect(vendorView(VAULT, 'testnet', s, policy, scorecard).pendingKeyMatchesArmed).toBe(false);
    expect(vendorView(VAULT, 'testnet', s, policy, scorecard, { lastArmedKey: 'ed25519:Other' }).pendingKeyMatchesArmed).toBe(false);
  });

  test('fairness carries the anti-framing policy raw, and flags weak settings (NF-06)', () => {
    const v = vendorView(VAULT, 'testnet', status(), policy, scorecard);
    expect(v.fairness).toEqual({
      payee_delay: '3600000000000',
      min_answer: '21600000000000',
      test_ttl: '86400000000000',
      reveal_grace: '600000000000',
      batch_size: 4,
      batch_interval: '3600000000000',
      limits_delay: '86400000000000',
      rearm_cooldown: '86400000000000',
    });
    expect(v.fairnessWarnings).toEqual(['min_answer_at_floor']); // 6 h is test_ttl / 4
    const weak = vendorView(VAULT, 'testnet', status(), { ...policy, payee_delay: '0', limits_delay: '0', min_answer: '21600000000001' }, scorecard);
    expect(weak.fairnessWarnings).toEqual(['payee_delay_under_1h', 'limits_delay_zero']);
    const old = vendorView(VAULT, 'testnet', status(), { ...policy, min_answer: undefined }, scorecard);
    expect(old.fairness.min_answer).toBeNull();
    expect(old.fairnessWarnings).toEqual([]);
  });

  test('history covers the key lifecycle and test outcomes, by their contract event names', () => {
    expect([...VENDOR_EVENTS].sort()).toEqual(['agent_armed', 'agent_demoted', 'agent_frozen', 'agent_key_changed', 'declined', 'key_proposed', 'test_revealed']);
  });
});

// own process: main-config reads env at import time and exits without it; no database is reachable
describe('routes refuse callers without a token before any read', () => {
  test('401 on the vendor console and the alert feed, never 404', async () => {
    const paths = ['/vendor/me', '/vendor/history', '/company/alerts'];
    const script = `const { buildApp } = await import(${JSON.stringify(resolve(ROOT, 'src/app.ts'))}); const a = await buildApp(); const out = [];
      for (const url of ${JSON.stringify(paths)}) { const r = await a.inject({ method: 'GET', url }); out.push(r.statusCode); }
      process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n'); process.exit(0);`;
    const p = Bun.spawn(['bun', '-e', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
        JWT_SECRET: 'x'.repeat(32),
        SHOP_CONTRACT_ID: 'shop.testnet',
        INBOX_TOKEN_HASH: '0'.repeat(64),
      },
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7))).toEqual([401, 401, 401]);
  }, 30_000);

  test('an invalid webhook URL stops the API at startup', async () => {
    const p = Bun.spawn(['bun', '-e', `await import(${JSON.stringify(resolve(ROOT, 'src/config/main-config.ts'))});`], {
      env: {
        PATH: process.env.PATH ?? '',
        DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
        JWT_SECRET: 'x'.repeat(32),
        SHOP_CONTRACT_ID: 'shop.testnet',
        INBOX_TOKEN_HASH: '0'.repeat(64),
        ALERT_WEBHOOK_URLS: 'http://hooks.example.com/SECRET',
      },
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(1);
    expect(err).toContain('ALERT_WEBHOOK_URLS: entry 1 must use https');
    expect(err).not.toContain('SECRET');
  }, 30_000);
});

// Real DB (a disposable test schema). Creates rows under this run's tag and removes only those.
const DB = process.env.TEST_DATABASE_URL;
const tag = randomBytes(4).toString('hex');

describe.skipIf(!DB)('vendor console and alert feed (Postgres)', () => {
  let app: FastifyInstance;
  let vendorApp: FastifyInstance;
  let prisma: typeof import('../src/lib/prisma.ts').prismaQuery;
  let shop = '';
  let secret = '';
  let chainUp = true;
  const users: string[] = [];
  let companyId = '';
  const vendorAccount = `vendor-${tag}.testnet`;
  let guarded = false;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      JWT_SECRET: randomBytes(32).toString('hex'),
      SHOP_CONTRACT_ID: `ss-test-${tag}.testnet`,
      INBOX_TOKEN_HASH: createHash('sha256').update(randomBytes(24)).digest('hex'),
      NEAR_NETWORK: 'testnet',
      LOG_LEVEL: 'error',
    });
    const config = await import('../src/config/main-config.ts');
    shop = config.SHOP_CONTRACT_ID;
    secret = config.JWT_SECRET;
    prisma = (await import('../src/lib/prisma.ts')).prismaQuery;
    await assertTestDatabase(prisma); // before any write
    guarded = true;
    app = await (await import('../src/app.ts')).buildApp();
    const { createVendorConsoleRoutes } = await import('../src/routes/vendorConsoleRoutes.ts');
    const fail = () => Promise.reject(new Error('rpc down'));
    vendorApp = Fastify();
    vendorApp.register(
      createVendorConsoleRoutes({
        status: () => (chainUp ? Promise.resolve(status({ vendor_id: vendorAccount, pending_key: PENDING })) : fail()),
        policy: () => Promise.resolve(policy),
        scorecard: () => Promise.resolve(scorecard),
      }),
      { prefix: '/vendor' }
    );

    const owner = await prisma.user.create({ data: { walletAddress: `owner-${tag}.testnet` } });
    users.push(owner.id);
    companyId = (await prisma.company.create({ data: { ownerUserId: owner.id, name: 'Alert Co', shopContractId: shop, vendorAccountId: vendorAccount, deployBlock: 1n } })).id;
    const events: [string, object][] = [
      ['key_proposed', { public_key: PENDING }],
      ['agent_armed', { public_key: PENDING, methods: 'pay,decline,ack', ok: true }],
      ['paid', { payment_id: 0, invoice_id: 'aa', payee: 'p.testnet', amount: '1', rail: 'Near', by_owner: false }],
      ['test_revealed', { slot_id: 0, status: 'Passed', contained: false, payee: 'l.testnet', invoice_id: 'bb', receipt_hash: 'x' }],
      ['test_revealed', { slot_id: 1, status: 'Failed', contained: false, payee: 'l.testnet', invoice_id: 'cc', receipt_hash: 'x' }],
      ['agent_demoted', { slot_id: 1, public_key: PENDING }],
      ['agent_key_changed', { public_key: PENDING, methods: 'propose,decline,ack', ok: true }],
      ['proposed', { proposal_id: 0, invoice_id: 'dd', payee: 'p.testnet', amount: '1440000' }],
      ['declined', { invoice_id: 'ee'.repeat(32), reason: 'Payee <@U1> not on file' }],
      ['agent_frozen', { public_key: PENDING }],
    ];
    for (const [i, [event, data]] of events.entries()) {
      await prisma.contractEvent.create({
        data: { receiptId: `r-${tag}-${i}`, logIndex: 0, txHash: `t-${tag}-${i}`, blockHeight: BigInt(100 + i), blockTime: new Date(Date.UTC(2026, 10, 12, 10, i)), contractId: shop, standard: 'secret_shopper', version: '2.3.0', event, data },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    if (!guarded) return void (await prisma.$disconnect());
    await prisma.contractEvent.deleteMany({ where: { contractId: shop } });
    await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await vendorApp?.close();
    await app?.close();
    await prisma.$disconnect();
  });

  const tokenFor = async (wallet: string) => {
    const u = await prisma.user.upsert({ where: { walletAddress: wallet }, create: { walletAddress: wallet }, update: {} });
    if (!users.includes(u.id)) users.push(u.id);
    return jwt.sign({ userId: u.id }, secret, { algorithm: 'HS256', expiresIn: '5m' });
  };
  const get = async (a: FastifyInstance, url: string, wallet?: string) =>
    a.inject({ method: 'GET', url, headers: wallet ? { authorization: `Bearer ${await tokenFor(wallet)}` } : {} });

  test('the on-chain vendor gets the console with the accept_key call', async () => {
    const res = await get(vendorApp, '/vendor/me', vendorAccount);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.vendorId).toBe(vendorAccount);
    expect(d.vault).toBe(shop);
    expect(d.acceptKey.args.public_key).toBe(PENDING);
    expect(d.limits.key_nonces).toBe(4);
    expect(d.pendingKeyProposedAt).toBe(dateToNs(new Date(Date.UTC(2026, 10, 12, 10, 0))));
    expect(d.pendingKeyMatchesArmed).toBe(true); // the indexed agent_armed event armed this key
    expect(d.fairness.payee_delay).toBe('3600000000000');
    expect(d.cooldownEndsAt).toBeNull();
  });

  test('anyone else is 403, the owner included; a failed chain read is 502', async () => {
    const other = await get(vendorApp, '/vendor/me', `owner-${tag}.testnet`);
    expect(other.statusCode).toBe(403);
    expect(other.json().error.message).toBe('Only the agent vendor');
    expect((await get(vendorApp, '/vendor/history', `someone-${tag}.testnet`)).statusCode).toBe(403);
    chainUp = false;
    try {
      expect((await get(vendorApp, '/vendor/me', vendorAccount)).statusCode).toBe(502);
    } finally {
      chainUp = true;
    }
  });

  test('history lists vendor events newest first, paged by before', async () => {
    const first = (await get(vendorApp, '/vendor/history?limit=4', vendorAccount)).json().data;
    expect(first.items.map((i: { kind: string }) => i.kind)).toEqual(['frozen', 'declined', 'key_changed', 'demoted']);
    expect(first.items[1].text).toBe('Agent declined invoice eeeeeeee: Payee \u2039\uff20U1\u203a not on file. Review it; pay manually or approve a proposal if it is genuine.');
    expect(first.items[3]).toEqual({
      id: first.nextBefore,
      kind: 'demoted',
      at: new Date(Date.UTC(2026, 10, 12, 10, 5)).toISOString(),
      text: `Agent demoted on ${shop}: it paid lure slot 1. Its key can now only propose payments.`,
      txHash: `t-${tag}-5`,
      slot: 1,
      proposalId: null,
      event: 'agent_demoted',
      blockHeight: '105',
    });
    const rest = (await get(vendorApp, `/vendor/history?limit=10&before=${first.nextBefore}`, vendorAccount)).json().data;
    expect(rest.items.map((i: { kind: string }) => i.kind)).toEqual(['test_failed', 'test_passed', 'armed', 'key_proposed']);
    expect(rest.nextBefore).toBeNull();
    expect((await get(vendorApp, '/vendor/history?limit=500', vendorAccount)).statusCode).toBe(400);
  });

  test('the owner alert feed holds alert-worthy events only, with their texts', async () => {
    const res = await get(app, '/company/alerts?limit=20', `owner-${tag}.testnet`);
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as { id: string; kind: string; text: string; proposalId: number | null }[];
    expect(items.map((i) => i.kind)).toEqual(['frozen', 'declined', 'proposal', 'demoted', 'test_failed', 'armed']);
    expect(items[1].text).toStartWith('Agent declined invoice eeeeeeee: ');
    expect(items[2].text).toContain('Owner approval needed.');
    expect(items[2].proposalId).toBe(0);
    expect(items[4].text).toBe(`Agent failed lure slot 1 on ${shop}: it paid l.testnet for invoice cc.`);
    expect(Object.keys(items[0]).sort()).toEqual(['at', 'blockHeight', 'event', 'id', 'kind', 'proposalId', 'slot', 'text', 'txHash']);
    const page = (await get(app, `/company/alerts?limit=2&before=${items[2].id}`, `owner-${tag}.testnet`)).json().data;
    expect(page.items.map((i: { kind: string }) => i.kind)).toEqual(['demoted', 'test_failed']);
  }, 30_000);

  test('the alert feed is owner only', async () => {
    expect((await get(app, '/company/alerts', vendorAccount)).statusCode).toBe(403);
    expect((await get(app, '/company/alerts')).statusCode).toBe(401);
  });
});
