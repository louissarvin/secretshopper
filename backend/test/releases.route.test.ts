import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { merkleRootHex } from '../src/lib/proof/merkle.ts';

// Real DB (a disposable test schema). Creates its own rows under a unique shop id and removes only those.
const DB = process.env.TEST_DATABASE_URL;
const SHOP = `ss-test-${randomBytes(4).toString('hex')}.testnet`;

describe.skipIf(!DB)('GET /public/releases/:shopId', () => {
  let app: FastifyInstance;
  let prisma: typeof import('../src/lib/prisma.ts').prismaQuery;
  let companyId = '';
  const tick = new Date(Math.floor((Date.now() - 3_600_000) / 60_000) * 60_000);
  const closed = ['3'.repeat(64), '1'.repeat(64), '2'.repeat(64)];
  const settling = new Date(Date.now() - 1_000); // visible, but inside the settle window
  const future = new Date(Date.now() + 3_600_000);

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      JWT_SECRET: randomBytes(32).toString('hex'),
      SHOP_CONTRACT_ID: SHOP,
      INBOX_TOKEN_HASH: createHash('sha256').update(randomBytes(24)).digest('hex'),
      NEAR_NETWORK: 'testnet',
      LOG_LEVEL: 'error',
    });
    prisma = (await import('../src/lib/prisma.ts')).prismaQuery;
    app = await (await import('../src/app.ts')).buildApp();
    const company = await prisma.company.create({
      data: { ownerUserId: 'test-owner', name: 'Release Test Co', shopContractId: SHOP, vendorAccountId: 'vendor.testnet', deployBlock: 1n },
    });
    companyId = company.id;
    const rows = [
      ...closed.map((invoiceId) => ({ invoiceId, deliverAt: tick })),
      { invoiceId: '4'.repeat(64), deliverAt: settling },
      { invoiceId: '5'.repeat(64), deliverAt: future },
    ];
    for (const r of rows) await prisma.invoice.create({ data: { companyId, ...r, document: { n: r.invoiceId.slice(0, 4) }, email: { subject: 'x' } } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.invoice.deleteMany({ where: { companyId } });
    await prisma.company.deleteMany({ where: { id: companyId } });
    await app?.close();
    await prisma.$disconnect();
  });

  const get = (path: string) => app.inject({ method: 'GET', url: `/public/releases/${path}` });

  test('lists closed ticks with sorted ids and the root anyone can recompute; no settling or future tick', async () => {
    const res = (await get(SHOP)).json();
    expect(res.success).toBe(true);
    expect(res.data.items).toHaveLength(1);
    const item = res.data.items[0];
    expect(item.releaseAt).toBe(tick.toISOString());
    expect(item.releaseAtNs).toBe((BigInt(tick.getTime()) * 1_000_000n).toString());
    expect(item.ids).toEqual([...closed].sort());
    expect(item.count).toBe(3);
    expect(item.root).toBe(merkleRootHex(item.ids));
    expect(res.data.nextSince).toBeNull();
  });

  test('since filters and pages; bad input is 400, unknown shop 404', async () => {
    const later = (await get(`${SHOP}?since=${encodeURIComponent(new Date(tick.getTime() + 1).toISOString())}`)).json();
    expect(later.data.items).toHaveLength(0);
    const paged = (await get(`${SHOP}?limit=1`)).json();
    expect(paged.data.nextSince).toBe(new Date(tick.getTime() + 1).toISOString());
    expect((await get(`${SHOP}?since=yesterday`)).statusCode).toBe(400);
    expect((await get(`${SHOP}?limit=0`)).statusCode).toBe(400);
    expect((await get(`${SHOP}?other=1`)).statusCode).toBe(400);
    expect((await get('unknown-shop.testnet')).statusCode).toBe(404);
  });
});
