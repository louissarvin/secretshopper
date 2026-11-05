import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { computeThroughput, windowFromSlots, type ChainSlot, type InvoiceDecision } from '../src/lib/throughput.ts';
import { buildReputation, CAVEAT, MAX_VAULTS, type ReputationReads, type VaultScorecard, type VaultStatus } from '../src/lib/reputation.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 0, 0, 0);
const NOW = T0 + 72 * H;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const id = (n: number) => n.toString(16).padStart(64, '0');
const inv = (n: number, atMs: number, d: Partial<InvoiceDecision> = {}): InvoiceDecision => ({ invoiceId: id(n), deliverAt: new Date(atMs), autoPaid: false, ownerPaid: false, proposed: false, declined: false, ...d });
const slot = (committedMs: number, status: string, invoiceId: string | null = null): ChainSlot => ({ status, committed_at: ns(committedMs), reveal: invoiceId ? { invoice_id: invoiceId } : null });

// Real invoices of a vault: paid, proposed and approved, proposed and pending, declined, undecided.
const REAL = [
  inv(1, T0 + 1 * H, { autoPaid: true }),
  inv(2, T0 + 2 * H, { proposed: true, ownerPaid: true }),
  inv(3, T0 + 3 * H, { proposed: true }),
  inv(4, T0 + 4 * H, { declined: true }),
  inv(5, T0 + 5 * H),
];

describe('throughput: real invoices only', () => {
  test('no sealed slot: everything delivered before now counts, with ratios in bps', () => {
    const t = computeThroughput(REAL, windowFromSlots([], NOW));
    expect(t).toEqual({
      asOf: new Date(NOW).toISOString(),
      excludedOpenWindow: false,
      delivered: 5,
      autoPaid: 1,
      proposed: 2,
      approvedByOwner: 1,
      declined: 1,
      undecided: 1,
      ratiosBps: { autoPaid: 2000, paid: 4000, proposed: 4000, approval: 5000, declined: 2000, undecided: 2000 },
    });
  });

  test('an agent that declines everything scores 100% on lures but shows a 100% decline rate here', () => {
    const t = computeThroughput(REAL.map((r) => ({ ...r, autoPaid: false, ownerPaid: false, proposed: false, declined: true })), windowFromSlots([], NOW));
    expect(t.ratiosBps).toMatchObject({ declined: 10_000, paid: 0 });
  });

  test('a revealed lure is excluded by id even inside the window; a future delivery is not counted', () => {
    const lure = inv(9, T0 + 2.5 * H, { declined: true });
    const w = windowFromSlots([slot(T0, 'Passed', lure.invoiceId)], NOW);
    expect(computeThroughput([...REAL, lure, inv(10, NOW + H, { autoPaid: true })], w).delivered).toBe(5);
  });

  test('a sealed slot cuts the window at its commit and says so', () => {
    const w = windowFromSlots([slot(T0 + 3.5 * H, 'Committed'), slot(T0 + 4.5 * H, 'Committed')], NOW);
    const t = computeThroughput(REAL, w);
    expect(t).toMatchObject({ asOf: new Date(T0 + 3.5 * H).toISOString(), excludedOpenWindow: true, delivered: 3, autoPaid: 1, proposed: 2, declined: 0 });
  });

  test('no leak: a sealed lure, whatever the agent did with it and whenever it lands after its commit, changes nothing', () => {
    for (const commitAt of [T0 + 0.5 * H, T0 + 4.5 * H, T0 + 10 * H]) {
      const base = [slot(T0 - 10 * H, 'Passed', id(99)), slot(commitAt, 'Committed')];
      const without = computeThroughput(REAL, windowFromSlots(base, NOW));
      for (const decision of [{}, { autoPaid: true }, { declined: true }, { proposed: true }, { proposed: true, ownerPaid: true }])
        for (const lag of [60_000, 2 * H, 20 * H]) {
          const lure = inv(500, commitAt + lag, decision);
          expect(computeThroughput([...REAL, lure], windowFromSlots(base, NOW))).toEqual(without);
        }
    }
  });
});

describe('agent reputation from chain', () => {
  const HASH = '5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs';
  const V = 'agentco.testnet';
  const card = (passed: number, failed: number, ignored = 0, demotions = failed, failed_contained = 0): VaultScorecard => ({
    stats: { passed, failed, failed_contained, ignored, unanswered: 1, demotions },
    score_bps: null,
    pending: 0,
  });
  const st = (owner: string, vendor = V): VaultStatus => ({ mode: 'Armed', owner_id: owner, vendor_id: vendor, agent_key: 'ed25519:K', armed_at: ns(T0), version: '2.3.0' });

  const stub = (vaults: Record<string, { hash: string | null; status: VaultStatus | null; card: VaultScorecard | null }>, extraCalls: { receiverId: string; methods: string[] }[] = []): ReputationReads => ({
    signedCalls: async () => ({ calls: [...Object.keys(vaults).map((v) => ({ receiverId: v, methods: ['accept_key'] })), ...extraCalls], truncated: false }),
    globalCodeHash: async (a) => vaults[a]?.hash ?? null,
    status: async (a) => vaults[a]?.status ?? null,
    scorecard: async (a) => vaults[a]?.card ?? null,
  });

  test('keeps vaults on the configured code that still name the vendor, pools the score, counts owners', async () => {
    const r = await buildReputation(
      V,
      HASH,
      stub(
        {
          'a.alice.testnet': { hash: HASH, status: st('alice.testnet'), card: card(7, 1) },
          'b.bob.testnet': { hash: HASH, status: st('bob.testnet'), card: card(3, 0, 1, 0, 1) },
          'c.agentco.testnet': { hash: HASH, status: st(V), card: card(10, 0) }, // the vendor testing itself
          'classic.alice.testnet': { hash: null, status: st('alice.testnet'), card: card(100, 0) },
          'other.alice.testnet': { hash: 'Other1111111111111111111111111111111111111', status: st('alice.testnet'), card: card(100, 0) },
          'moved.alice.testnet': { hash: HASH, status: st('alice.testnet', 'someoneelse.testnet'), card: card(100, 0) },
        },
        [{ receiverId: 'tusdc.testnet', methods: ['ft_transfer'] }]
      )
    );
    expect(r.vaults.map((v) => [v.vaultId, v.ownerId, v.ownedByVendor])).toEqual([
      ['a.alice.testnet', 'alice.testnet', false],
      ['b.bob.testnet', 'bob.testnet', false],
      ['c.agentco.testnet', V, true],
    ]);
    // pooled: 20 passed of 20 + 1 failed + 1 contained + 1 ignored = 23
    expect(r.aggregate).toEqual({ vaults: 3, distinctOwners: 3, passed: 20, failed: 2, failedContained: 1, ignored: 1, unanswered: 3, scoreBps: Math.floor((20 * 10_000) / 23), demotions: 1 });
    expect(r.vaults[0]).toMatchObject({ mode: 'Armed', armedAt: new Date(T0).toISOString(), demotions: 1, version: '2.3.0' });
    expect(r.caveat).toBe(CAVEAT);
    expect(r.truncated).toEqual({ txs: false, vaults: false });
  });

  test('no vaults gives a null score; more than 50 candidates are cut and flagged; no code hash configured finds nothing', async () => {
    expect((await buildReputation(V, HASH, stub({}))).aggregate).toMatchObject({ vaults: 0, scoreBps: null });
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`v${i}.alice.testnet`, { hash: HASH, status: st('alice.testnet'), card: card(1, 0) }]));
    const r = await buildReputation(V, HASH, stub(many));
    expect(r.vaults).toHaveLength(MAX_VAULTS);
    expect(r.truncated.vaults).toBe(true);
    expect((await buildReputation(V, '', stub(many))).vaults).toEqual([]);
  });
});

// GET /public/agent over HTTP: stand-in FastNEAR tx API with no txs; uncached scans share a 20 a minute budget.
describe('GET /public/agent', () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => Response.json(new URL(req.url).pathname === '/v0/account' ? { account_txs: [] } : { transactions: [] }) });
  });
  afterAll(() => server.stop(true));

  test('400 on a bad id; 200 with an empty record; the 21st distinct vendor in a minute is 503; a cached one still answers', async () => {
    const urls = ['/public/agent/Bad..Id', ...Array.from({ length: 21 }, (_, i) => `/public/agent/v${i}.testnet`), '/public/agent/v0.testnet'];
    const app = resolve(import.meta.dir, '../src/app.ts');
    const script = `const { buildApp } = await import(${JSON.stringify(app)}); const a = await buildApp(); const out = [];
      for (const url of ${JSON.stringify(urls)}) { const r = await a.inject({ method: 'GET', url }); out.push({ status: r.statusCode, body: r.json() }); }
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
        NEAR_TX_API_URL: `http://127.0.0.1:${server.port}`,
        NEAR_RPC_URL: `http://127.0.0.1:${server.port}`,
        NEAR_RPC_URLS: `http://127.0.0.1:${server.port}`, // Bun loads backend/.env from cwd
      },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    const res = JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7)) as { status: number; body: { data: { aggregate: { vaults: number }; caveat: string } | null; error: { code: string } | null } }[];
    expect(res[0].status).toBe(400);
    expect(res.slice(1, 21).every((r) => r.status === 200)).toBe(true);
    expect(res[1].body.data).toMatchObject({ vendorId: 'v0.testnet', vaults: [], aggregate: { vaults: 0, scoreBps: null }, caveat: CAVEAT });
    expect(res[21].status).toBe(503);
    expect(res[21].body.error?.code).toBe('REPUTATION_BUSY');
    expect(res[22].status).toBe(200);
  }, 30_000);
});

// The SQL of GET /public/throughput against Postgres (TEST_DATABASE_URL), with a stand-in RPC for get_tests.
const DB = process.env.TEST_DATABASE_URL;
describe.skipIf(!DB)('GET /public/throughput with Postgres', () => {
  const tag = randomBytes(4).toString('hex');
  const SHOP = `ss-tp-${tag}.testnet`;
  const at = (h: number) => new Date(Date.now() - 48 * H + h * H);
  // slot 0 revealed (its invoice is lure L1), slot 1 sealed, committed 30 h into the 48 h history
  const L1 = id(0x1001);
  const L2 = id(0x1002); // the sealed lure, delivered 31 h in and paid by the agent
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    const slots = [
      { commitment: '00', batch: 0, committed_at: ns(at(0).getTime()), expires_at: '0', status: 'Passed', contained: false, tlock_round: 1, ciphertext_sha256: '00', demoted: false, reveal: { payee: 'x', invoice_id: L1, receipt_hash: '00', salt: '00', at: '1', by: 'x' } },
      { commitment: '01', batch: 1, committed_at: ns(at(30).getTime()), expires_at: '0', status: 'Committed', contained: false, tlock_round: 1, ciphertext_sha256: '00', demoted: false, reveal: null },
    ];
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const body = (await req.json()) as { id: unknown; params: { args_base64?: string } };
        const from = JSON.parse(Buffer.from(body.params.args_base64 ?? '', 'base64').toString() || '{}').from ?? 0;
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { result: [...new TextEncoder().encode(JSON.stringify(from === 0 ? slots : []))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } });
      },
    });
  });
  afterAll(() => server?.stop(true));

  test('counts real invoices by indexed decision, drops the revealed lure and everything from the sealed commit on', async () => {
    const prismaPath = resolve(import.meta.dir, '../src/lib/prisma.ts');
    const app = resolve(import.meta.dir, '../src/app.ts');
    const script = `
      const { prismaQuery: db } = await import(${JSON.stringify(prismaPath)});
      const a = await (await import(${JSON.stringify(app)})).buildApp();
      const at = (h) => new Date(Date.now() - 48 * ${H} + h * ${H});
      const c = await db.company.create({ data: { ownerUserId: 'tp-${tag}', name: 'tp', shopContractId: '${SHOP}', vendorAccountId: 'vendor.testnet', deployBlock: 1n } });
      const invs = [['${id(1)}', 1], ['${id(2)}', 2], ['${id(3)}', 3], ['${id(4)}', 4], ['${id(5)}', 5], ['${L1}', 6], ['${id(7)}', 32], ['${L2}', 31]];
      const ev = [['paid', '${id(1)}', { by_owner: false }], ['proposed', '${id(2)}', {}], ['paid', '${id(2)}', { by_owner: true }], ['proposed', '${id(3)}', {}], ['declined', '${id(4)}', {}], ['declined', '${L1}', {}], ['paid', '${id(7)}', { by_owner: false }], ['paid', '${L2}', { by_owner: false }], ['declined', '${id(5)}', {}]];
      const out = {};
      try {
        for (const [invoiceId, h] of invs) await db.invoice.create({ data: { companyId: c.id, invoiceId, document: {}, email: {}, deliverAt: at(h) } });
        // the declined event for invoice 5 is on another vault, so 5 stays undecided here
        let n = 0;
        for (const [event, invoice_id, extra] of ev) await db.contractEvent.create({ data: { receiptId: 'tp-${tag}-' + n, logIndex: n++, txHash: 'tx', blockHeight: 1n, blockTime: new Date(), contractId: invoice_id === '${id(5)}' ? 'elsewhere.testnet' : '${SHOP}', standard: 'secret_shopper', version: '2.0.0', event, data: { invoice_id, ...extra } } });
        const r = await a.inject({ method: 'GET', url: '/public/throughput/${SHOP}' });
        out.status = r.statusCode; out.body = r.json();
        out.unknown = (await a.inject({ method: 'GET', url: '/public/throughput/nobody-${tag}.testnet' })).statusCode;
      } finally {
        await db.contractEvent.deleteMany({ where: { receiptId: { startsWith: 'tp-${tag}-' } } });
        await db.invoice.deleteMany({ where: { companyId: c.id } });
        await db.company.deleteMany({ where: { id: c.id } });
        await db.$disconnect();
      }
      process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n'); process.exit(0);`;
    const p = Bun.spawn(['bun', '-e', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LOG_LEVEL: 'silent',
        DATABASE_URL: DB!,
        JWT_SECRET: 'x'.repeat(32),
        SHOP_CONTRACT_ID: SHOP,
        INBOX_TOKEN_HASH: createHash('sha256').update('t').digest('hex'),
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: `http://127.0.0.1:${server.port}`,
        NEAR_RPC_URLS: `http://127.0.0.1:${server.port}`,
      },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    const r = JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ shopId: SHOP, excludedOpenWindow: true, delivered: 5, autoPaid: 1, proposed: 2, approvedByOwner: 1, declined: 1, undecided: 1 });
    expect(Date.parse(r.body.data.asOf)).toBeGreaterThan(at(29.9).getTime());
    expect(Date.parse(r.body.data.asOf)).toBeLessThan(at(30.1).getTime());
    expect(r.unknown).toBe(404);
  }, 60_000);
});
