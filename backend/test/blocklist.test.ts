import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { verifyEvidence, type EvidenceReads, type RevealedSlot, type VaultEvent } from '../src/lib/blocklist/evidence.ts';
import { isTxHash } from '../src/lib/blocklist/chainReads.ts';
import { blocklistFailedReveals, type BlocklistDeps } from '../src/tester/blocklist.ts';
import type { NewEntry } from '../src/lib/blocklist/store.ts';

const PAYEE = '3c23855018f7bc402b49e8b8d2f883f81c33b7434e3f660ca3f9277f5ee31ac6';
const OTHER = 'vendor.testnet';
const TX = 'AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az'; // shop4 slot 5 reveal, Failed
const TX2 = 'BACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az';
const INV = '3bcfa069292c17ec4bc449fb1caa1b50355005f1cda104c58b685b78f9cf5fb1';

const reads = (txs: Record<string, VaultEvent[]>, slots: RevealedSlot[] = []): EvidenceReads & { slotReads: number } => {
  const r = {
    slotReads: 0,
    txVaultEvents: async (h: string) => txs[h] ?? null,
    revealedSlots: async () => (r.slotReads++, slots),
  };
  return r;
};
const revealed = (status: string, payee = PAYEE, slot_id = 5): VaultEvent => ({ event: 'test_revealed', data: { slot_id, status, contained: false, payee, invoice_id: INV, receipt_hash: '00' } });

describe('blocklist evidence rules', () => {
  test('a Failed reveal naming the account is accepted without reading slots', async () => {
    const r = reads({ [TX]: [revealed('Failed'), { event: 'agent_demoted', data: { slot_id: 5 } }] });
    expect(await verifyEvidence(PAYEE, TX, r)).toEqual({ ok: true, kind: 'failed_reveal', slotId: 5 });
    expect(r.slotReads).toBe(0);
  });

  test('a reveal that passed, or that names someone else, is refused', async () => {
    expect((await verifyEvidence(PAYEE, TX, reads({ [TX]: [revealed('Passed')] }))).ok).toBe(false);
    expect((await verifyEvidence(OTHER, TX, reads({ [TX]: [revealed('Failed')] }))).ok).toBe(false);
  });

  test('an unknown tx or one with no event from this vault is refused with a reason', async () => {
    expect(await verifyEvidence(PAYEE, TX, reads({}))).toEqual({ ok: false, reason: 'transaction not found; retry once it is final and indexed' });
    expect(await verifyEvidence(PAYEE, TX, reads({ [TX]: [] }))).toEqual({ ok: false, reason: 'the transaction has no successful event from this vault' });
  });

  test('a payment to the account counts only once a slot naming it was revealed Failed', async () => {
    const paid = { [TX2]: [{ event: 'paid', data: { payment_id: 1, invoice_id: 'ab'.repeat(32), payee: PAYEE, amount: '1', rail: 'Near', by_owner: false } }] };
    expect(await verifyEvidence(PAYEE, TX2, reads(paid, [{ slotId: 5, status: 'Failed', payee: PAYEE, invoiceId: INV }]))).toEqual({ ok: true, kind: 'paid_lure', slotId: 5 });
    const notYet = await verifyEvidence(PAYEE, TX2, reads(paid, [{ slotId: 5, status: 'Passed', payee: PAYEE, invoiceId: INV }]));
    expect(notYet).toEqual({ ok: false, reason: 'the vault paid this account, but no revealed test names it as a Failed lure payee' });
  });

  test('a decline counts only when a revealed slot shows the invoice was a lure for the account', async () => {
    const declined = { [TX2]: [{ event: 'declined', data: { invoice_id: INV, reason: 'payee change' } }] };
    expect(await verifyEvidence(PAYEE, TX2, reads(declined, [{ slotId: 5, status: 'Passed', payee: PAYEE, invoiceId: INV }]))).toEqual({ ok: true, kind: 'declined_invoice', slotId: 5 });
    expect((await verifyEvidence(OTHER, TX2, reads(declined, [{ slotId: 5, status: 'Passed', payee: PAYEE, invoiceId: INV }]))).ok).toBe(false);
    // before the reveal there is no slot to tie the invoice to the account
    expect(await verifyEvidence(PAYEE, TX2, reads(declined, []))).toEqual({ ok: false, reason: 'the declined invoice is not a revealed lure for this account' });
  });

  test('tx hashes must be base58 of 32 bytes', () => {
    expect(isTxHash(TX)).toBe(true);
    expect(isTxHash('1'.repeat(44))).toBe(false);
    expect(isTxHash('0OIl'.repeat(11))).toBe(false);
    expect(isTxHash('short')).toBe(false);
  });
});

describe('tester: Failed reveals go on the blocklist', () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const deps = (over: Partial<BlocklistDeps> = {}) => {
    const recorded: NewEntry[] = [];
    const d: BlocklistDeps = {
      failedReveals: async () => [
        { slotIndex: 5, payee: PAYEE, revealTxHash: TX },
        { slotIndex: 9, payee: OTHER, revealTxHash: TX2 },
      ],
      listed: async (a) => a === OTHER,
      verify: async (a, t) => verifyEvidence(a, t, reads({ [TX]: [revealed('Failed')] })),
      record: async (e) => (recorded.push(e), { created: true }),
      reporterId: 'owner.testnet',
      vault: 'shop4.owner.testnet',
      log: quiet,
      ...over,
    };
    return { d, recorded };
  };

  test('records the verified one with the reveal tx, skips what is listed', async () => {
    const { d, recorded } = deps();
    expect(await blocklistFailedReveals(d)).toBe(1);
    expect(recorded).toEqual([
      {
        accountId: PAYEE,
        reason: 'Lure payee of test slot 5 on shop4.owner.testnet: the agent paid it and the reveal scored Failed.',
        evidenceTx: TX,
        evidenceKind: 'failed_reveal',
        reporterKind: 'tester',
        reporterId: 'owner.testnet',
        vault: 'shop4.owner.testnet',
      },
    ]);
  });

  test('nothing is recorded without on-chain evidence, and one failing write does not stop the rest', async () => {
    const none = deps({ verify: async () => ({ ok: false, reason: 'transaction not found; retry once it is final and indexed' }) });
    expect(await blocklistFailedReveals(none.d)).toBe(0);
    expect(none.recorded).toEqual([]);
    let calls = 0;
    const flaky = deps({ listed: async () => false, verify: async (a) => ({ ok: true, kind: 'failed_reveal', slotId: a === PAYEE ? 5 : 9 }), record: async () => (++calls === 1 ? Promise.reject(new Error('db down')) : { created: true }) });
    expect(await blocklistFailedReveals(flaky.d)).toBe(1);
    expect(calls).toBe(2);
  });
});

// Routes through the real app in their own process; no database is reachable, so only what precedes it is covered.
describe('blocklist routes: auth and validation', () => {
  const TOKEN = 'inbox-token-for-tests';
  const run = async (reqs: { method: 'GET' | 'POST'; url: string; payload?: unknown; headers?: Record<string, string> }[]) => {
    const app = resolve(import.meta.dir, '../src/app.ts');
    const script = `const { buildApp } = await import(${JSON.stringify(app)}); const a = await buildApp(); const out = [];
      for (const r of ${JSON.stringify(reqs)}) { const res = await a.inject(r); out.push({ status: res.statusCode, body: res.json() }); }
      process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n'); process.exit(0);`;
    const p = Bun.spawn(['bun', '-e', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
        JWT_SECRET: 'x'.repeat(32),
        SHOP_CONTRACT_ID: 'shop.testnet',
        INBOX_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex'),
      },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7)) as { status: number; body: { error: { code: string; message: string } | null } }[];
  };
  const agent = { authorization: `Bearer ${TOKEN}` };
  const good = { accountId: PAYEE, reason: 'paid lure', evidenceTx: TX };

  test('owner route needs a JWT, agent routes need the inbox token, bodies are strict', async () => {
    const res = await run([
      { method: 'POST', url: '/blocklist', payload: good },
      { method: 'POST', url: '/inbox/blocklist', payload: good },
      { method: 'POST', url: '/inbox/blocklist', payload: good, headers: { authorization: 'Bearer wrong' } },
      { method: 'GET', url: `/inbox/blocklist/${PAYEE}` },
      { method: 'POST', url: '/inbox/blocklist', payload: { ...good, evidenceTx: '1'.repeat(44) }, headers: agent },
      { method: 'POST', url: '/inbox/blocklist', payload: { ...good, reason: 'x'.repeat(281) }, headers: agent },
      { method: 'POST', url: '/inbox/blocklist', payload: { ...good, reason: 'line\nbreak' }, headers: agent },
      { method: 'POST', url: '/inbox/blocklist', payload: { ...good, extra: 1 }, headers: agent },
      { method: 'GET', url: '/public/blocklist/Not..Valid' },
      { method: 'GET', url: '/public/blocklist?limit=0' },
      { method: 'GET', url: '/public/blocklist?before=not-a-cuid!' },
    ]);
    expect(res.map((r) => r.status)).toEqual([401, 401, 401, 401, 400, 400, 400, 400, 400, 400, 400]);
    expect(res[4].body.error?.message).toBe('Invalid input: evidenceTx');
  }, 30_000);
});

// Real database (a disposable schema) plus local stand-ins for the FastNEAR tx API and RPC. The app runs in its own
// process: main-config is read once per process, so importing it here would fight the other DB-gated files over env.
const DB = process.env.TEST_DATABASE_URL;
describe.skipIf(!DB)('blocklist with Postgres', () => {
  const tag = randomBytes(4).toString('hex');
  const SHOP = `ss-bl-${tag}.testnet`;
  const TOKEN = randomBytes(16).toString('hex');
  const SECRET = randomBytes(32).toString('hex');
  let server: ReturnType<typeof Bun.serve>;
  const enc = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
  const ev = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: 'secret_shopper', version: '2.0.0', event, data })}`;
  const txs: Record<string, string[]> = {
    [TX]: [ev('test_revealed', { slot_id: 0, status: 'Failed', contained: false, payee: PAYEE, invoice_id: INV, receipt_hash: '00' })],
    [TX2]: [ev('declined', { invoice_id: INV, reason: 'payee change' })],
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const body = (await req.json()) as { tx_hashes?: string[]; id?: unknown; params?: Record<string, unknown> };
        if (new URL(req.url).pathname === '/v0/transactions') {
          return Response.json({
            transactions: (body.tx_hashes ?? []).filter((h) => txs[h]).map((h) => ({
              transaction: { hash: h },
              receipts: [{ execution_outcome: { id: `r-${h}`, block_height: 1, block_timestamp: '1', outcome: { executor_id: SHOP, logs: txs[h], status: { SuccessValue: '' } } } }],
            })),
          });
        }
        // get_tests: one revealed Failed slot naming PAYEE under INV
        const slot = { commitment: '00', batch: 0, committed_at: '1', expires_at: '2', status: 'Failed', contained: false, tlock_round: 1, ciphertext_sha256: '00', demoted: true, reveal: { payee: PAYEE, invoice_id: INV, receipt_hash: '00', salt: '00', at: '3', by: SHOP } };
        const from = JSON.parse(Buffer.from(String(body.params?.args_base64 ?? ''), 'base64').toString() || '{}').from ?? 0;
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { result: enc(from === 0 ? [slot] : []), logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } });
      },
    });
  });
  afterAll(() => server?.stop(true));

  test('owner report with a Failed reveal is listed once; agent report of a lure decline adds a second entry; public reads see both', async () => {
    const app = resolve(import.meta.dir, '../src/app.ts');
    const prismaPath = resolve(import.meta.dir, '../src/lib/prisma.ts');
    const script = `
      const { prismaQuery: db } = await import(${JSON.stringify(prismaPath)});
      const jwt = (await import('jsonwebtoken')).default;
      const a = await (await import(${JSON.stringify(app)})).buildApp();
      const out = {};
      const user = await db.user.create({ data: { walletAddress: 'owner-${tag}.testnet' } });
      const company = await db.company.create({ data: { ownerUserId: user.id, name: '${SHOP}', shopContractId: '${SHOP}', vendorAccountId: 'vendor.testnet', deployBlock: 1n } });
      try {
        const owner = { authorization: 'Bearer ' + jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' }) };
        const agent = { authorization: 'Bearer ${TOKEN}' };
        const body = { accountId: '${PAYEE}', reason: 'paid lure, slot 0', evidenceTx: '${TX}' };
        const call = async (k, r) => { const res = await a.inject(r); out[k] = { status: res.statusCode, body: res.json() }; };
        await call('first', { method: 'POST', url: '/blocklist', payload: body, headers: owner });
        await call('again', { method: 'POST', url: '/blocklist', payload: body, headers: owner });
        await call('wrong', { method: 'POST', url: '/blocklist', payload: { ...body, accountId: 'someone.testnet' }, headers: owner });
        await call('agent', { method: 'POST', url: '/inbox/blocklist', payload: { ...body, evidenceTx: '${TX2}' }, headers: agent });
        await call('one', { method: 'GET', url: '/public/blocklist/${PAYEE}' });
        await call('viaAgent', { method: 'GET', url: '/inbox/blocklist/${PAYEE}', headers: agent });
        await call('nobody', { method: 'GET', url: '/public/blocklist/nobody.testnet' });
        await call('page1', { method: 'GET', url: '/public/blocklist?limit=1' });
        await call('page2', { method: 'GET', url: '/public/blocklist?limit=1&before=' + out.page1.body.data.nextBefore });
      } finally {
        await db.blocklistEntry.deleteMany({ where: { vault: '${SHOP}' } });
        await db.company.deleteMany({ where: { id: company.id } });
        await db.user.deleteMany({ where: { id: user.id } });
        await db.$disconnect();
      }
      process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n'); process.exit(0);`;
    const p = Bun.spawn(['bun', '-e', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LOG_LEVEL: 'silent',
        DATABASE_URL: DB!,
        JWT_SECRET: SECRET,
        SHOP_CONTRACT_ID: SHOP,
        INBOX_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex'),
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: `http://127.0.0.1:${server.port}`,
        // Bun loads backend/.env from cwd; pin every chain endpoint so nothing reaches a real network
        NEAR_RPC_URLS: `http://127.0.0.1:${server.port}`,
        NEAR_TX_API_URL: `http://127.0.0.1:${server.port}`,
      },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    type R = { status: number; body: { data: Record<string, any>; error: { code: string } | null } };
    const r = JSON.parse(stdout.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7)) as Record<string, R>;

    expect(r.first.status).toBe(201);
    expect(r.first.body.data.entry).toMatchObject({ accountId: PAYEE, evidenceTx: TX, evidenceKind: 'failed_reveal', reporterKind: 'owner', reporterId: `owner-${tag}.testnet`, vault: SHOP, verified: true });
    expect(r.again.status).toBe(200);
    expect(r.again.body.data.created).toBe(false);
    expect(r.wrong.status).toBe(422);
    expect(r.wrong.body.error?.code).toBe('EVIDENCE_REJECTED');
    expect(r.agent.status).toBe(201);
    expect(r.agent.body.data.entry).toMatchObject({ evidenceKind: 'declined_invoice', reporterKind: 'agent', reporterId: `agent:${SHOP}` });
    // first read of this account in the process, so the 5 s cache holds nothing stale
    expect(r.one.body.data).toMatchObject({ listed: true, count: 2 });
    expect(r.one.body.data.entries.map((e: { evidenceTx: string }) => e.evidenceTx)).toEqual([TX, TX2]);
    expect(r.viaAgent.body.data.listed).toBe(true);
    expect(r.nobody.body.data).toMatchObject({ listed: false, count: 0, entries: [] });
    expect(r.page1.body.data.items).toHaveLength(1);
    expect(r.page2.status).toBe(200);
    expect(r.page2.body.data.items[0].id).not.toBe(r.page1.body.data.items[0].id);
  }, 60_000);
});
