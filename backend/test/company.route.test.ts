import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';

// Real DB (a disposable test schema). An owner with several registered vaults must only ever see this deployment's.
const DB = process.env.TEST_DATABASE_URL;
const tag = randomBytes(4).toString('hex');

describe.skipIf(!DB)('GET /company/me is scoped to this deployment', () => {
  let app: FastifyInstance;
  let prisma: typeof import('../src/lib/prisma.ts').prismaQuery;
  let shop = '';
  let secret = '';
  const users: string[] = [];
  const companies: string[] = [];

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
    app = await (await import('../src/app.ts')).buildApp();
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.company.deleteMany({ where: { id: { in: companies } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await prisma.$disconnect();
  });

  const user = async (name: string) => {
    const u = await prisma.user.create({ data: { walletAddress: `${name}-${tag}.testnet` } });
    users.push(u.id);
    return { id: u.id, token: jwt.sign({ userId: u.id }, secret, { algorithm: 'HS256', expiresIn: '5m' }) };
  };
  const company = async (ownerUserId: string, shopContractId: string) => {
    const c = await prisma.company.create({ data: { ownerUserId, name: shopContractId, shopContractId, vendorAccountId: 'vendor.testnet', deployBlock: 1n } });
    companies.push(c.id);
    return c;
  };
  const me = (token: string) => app.inject({ method: 'GET', url: '/company/me', headers: { authorization: `Bearer ${token}` } });

  test('an owner of an older vault and this one gets this one, whatever the insert order', async () => {
    const owner = await user('owner');
    await company(owner.id, `old-a-${tag}.testnet`); // registered first, so findFirst without the scope returned it
    const current = await company(owner.id, shop);
    await company(owner.id, `old-b-${tag}.testnet`);
    const res = (await me(owner.token)).json();
    expect(res.success).toBe(true);
    expect(res.data.id).toBe(current.id);
    expect(res.data.shopContractId).toBe(shop);
  });

  test('an owner of other vaults only gets null here, and the owner routes refuse them', async () => {
    const other = await user('other');
    await company(other.id, `elsewhere-${tag}.testnet`);
    const res = (await me(other.token)).json();
    expect(res.success).toBe(true);
    expect(res.data).toBeNull();
    const tests = await app.inject({ method: 'GET', url: '/tests', headers: { authorization: `Bearer ${other.token}` } });
    expect(tests.statusCode).toBe(403);
  });

  test('no token is 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/company/me' })).statusCode).toBe(401);
  });
});
