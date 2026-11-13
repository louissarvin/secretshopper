import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Real DB (a disposable test schema). Creates its own rows under a unique shop id and removes only those.
const DB = process.env.TEST_DATABASE_URL;
// A per-company token: the env token hash is read once per process, so another test file may have fixed it first
const TOKEN = `ssi_${randomBytes(32).toString('base64url')}`;
const SHOP = `ss-test-${randomBytes(4).toString('hex')}.testnet`;

describe.skipIf(!DB)('GET /inbox/next', () => {
  let app: FastifyInstance;
  let prisma: typeof import('../src/lib/prisma.ts').prismaQuery;
  let companyId = '';
  const ids = { real: '1'.repeat(64), test: '2'.repeat(64), future: '3'.repeat(64) };

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      JWT_SECRET: randomBytes(32).toString('hex'),
      SHOP_CONTRACT_ID: SHOP,
      INBOX_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex'),
      NEAR_NETWORK: 'testnet',
      LOG_LEVEL: 'error',
    });
    prisma = (await import('../src/lib/prisma.ts')).prismaQuery;
    app = await (await import('../src/app.ts')).buildApp();
    const company = await prisma.company.create({
      data: {
        ownerUserId: 'test-owner',
        name: 'Inbox Test Co',
        shopContractId: SHOP,
        vendorAccountId: 'vendor.testnet',
        deployBlock: 1n,
        inboxTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
      },
    });
    companyId = company.id;
    const past = new Date(Date.now() - 60_000);
    await prisma.invoice.create({
      data: { companyId, invoiceId: ids.real, document: { number: 'R-1', pay_to: 'acme.testnet' }, email: { subject: 'Invoice R-1' }, deliverAt: past },
    });
    const testInvoice = await prisma.invoice.create({
      data: { companyId, invoiceId: ids.test, document: { number: 'T-1', pay_to: 'f'.repeat(64) }, email: { subject: 'Bank change' }, deliverAt: past },
    });
    await prisma.testSlot.create({
      data: { companyId, slotIndex: 0, commitment: 'a'.repeat(64), sealed: 'opaque', status: 'Committed', invoiceRowId: testInvoice.id },
    });
    await prisma.invoice.create({
      data: { companyId, invoiceId: ids.future, document: { number: 'F-1' }, email: { subject: 'later' }, deliverAt: new Date(Date.now() + 3_600_000) },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.testSlot.deleteMany({ where: { companyId } });
    await prisma.invoice.deleteMany({ where: { companyId } });
    await prisma.company.deleteMany({ where: { id: companyId } });
    await app?.close();
    await prisma.$disconnect();
  });

  const next = (query = '', token: string | null = TOKEN) =>
    app.inject({ method: 'GET', url: `/inbox/next${query}`, headers: token ? { authorization: `Bearer ${token}` } : {} });

  test('401 without or with a wrong token', async () => {
    expect((await next('', null)).statusCode).toBe(401);
    expect((await next('', 'wrong')).statusCode).toBe(401);
  });

  test('test and real invoices serialize to exactly the same keys; cursor walks (deliverAt, id)', async () => {
    const first = (await next()).json();
    expect(first.success).toBe(true);
    expect(Object.keys(first.data).sort()).toEqual(['document', 'email', 'id', 'receivedAt']);
    expect(first.data.id).toBe(ids.real); // same deliverAt, ordered by invoice id

    const second = (await next(`?afterAt=${encodeURIComponent(first.data.receivedAt)}&afterId=${first.data.id}`)).json();
    expect(second.data.id).toBe(ids.test);
    expect(Object.keys(second.data).sort()).toEqual(Object.keys(first.data).sort());

    // the future invoice is not delivered yet
    const third = (await next(`?afterAt=${encodeURIComponent(second.data.receivedAt)}&afterId=${second.data.id}`)).json();
    expect(third.data).toBeNull();
  });

  test('rejects malformed cursors', async () => {
    expect((await next('?afterId=' + 'Z'.repeat(64))).statusCode).toBe(400);
    expect((await next('?afterAt=2026-11-01T00:00:00.000Z')).statusCode).toBe(400);
  });
});
