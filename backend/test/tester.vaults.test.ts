import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { testerKeyFor } from '../src/tester/keys.ts';
import { assertTestDatabase } from './dbGuard.ts';

// Real DB (a disposable test schema): which vaults the tester serves, and the public keys it writes for the API.
const DB = process.env.TEST_DATABASE_URL;
const tag = randomBytes(4).toString('hex');
const SEED_HEX = randomBytes(32).toString('hex');

describe.skipIf(!DB)('tester vault selection and key provisioning (Postgres)', () => {
  let prisma: typeof import('../src/lib/prisma.ts').prismaQuery;
  let vaults: typeof import('../src/tester/vaults.ts');
  let defaultShop = '';
  let defaultKey = '';
  const shops = { enabled: `en-${tag}.testnet`, open: `open-${tag}.testnet`, idle: `idle-${tag}.testnet` };
  const ids: Record<string, string> = {};
  let guarded = false;

  beforeAll(async () => {
    const kp = KeyPair.fromRandom('ed25519');
    Object.assign(process.env, {
      DATABASE_URL: DB,
      NEAR_NETWORK: 'testnet',
      SHOP_CONTRACT_ID: `def-${tag}.testnet`,
      TESTER_ACCOUNT_ID: `owner-${tag}.testnet`,
      TESTER_PRIVATE_KEY: kp.toString(),
      USDC_CONTRACT_ID: 'tusdc.testnet',
      TEST_SEAL_KEY: randomBytes(32).toString('hex'),
      TESTER_KEY_SEED: SEED_HEX,
      LOG_LEVEL: 'error',
    });
    const config = await import('../src/tester/config.ts');
    defaultShop = config.SHOP_CONTRACT_ID; // another file may have loaded the config first
    defaultKey = config.TESTER_PRIVATE_KEY;
    prisma = (await import('../src/lib/prisma.ts')).prismaQuery;
    await assertTestDatabase(prisma); // before any write
    guarded = true;
    vaults = await import('../src/tester/vaults.ts');
    const mk = async (shop: string, data: object = {}) => {
      const c = await prisma.company.create({ data: { ownerUserId: `u-${tag}`, name: shop, shopContractId: shop, vendorAccountId: 'v.testnet', deployBlock: 1n, ...data } });
      ids[shop] = c.id;
      return c;
    };
    if (!(await prisma.company.findUnique({ where: { shopContractId: defaultShop } }))) await mk(defaultShop);
    await mk(shops.enabled, { testerEnabled: true, testerEnabledAt: new Date(), testerPublicKey: 'ed25519:forged' });
    const open = await mk(shops.open); // testing disabled, but a committed slot is still waiting for its reveal
    await prisma.sealedSlot.create({
      data: { companyId: open.id, runId: tag, commitment: `${tag}`.padEnd(64, '0'), sealed: 'x', ciphertext: 'x', ciphertextSha256: '0'.repeat(64), tlockRound: 1n, status: 'Committed' },
    });
    await mk(shops.idle);
  });

  // by this run's tag, not by remembered ids, so a setup that failed halfway still leaves nothing behind
  afterAll(async () => {
    if (!prisma) return;
    if (guarded) {
      const mine = await prisma.company.findMany({ where: { shopContractId: { endsWith: `-${tag}.testnet` } }, select: { id: true } });
      const all = mine.map((c) => c.id);
      await prisma.sealedSlot.deleteMany({ where: { OR: [{ companyId: { in: all } }, { runId: tag }] } });
      await prisma.company.deleteMany({ where: { id: { in: all } } });
    }
    await prisma.$disconnect();
  });

  test('serves enabled vaults and vaults with open slots, never an idle one or the default twice', async () => {
    const mine = (await vaults.candidateCompanies()).map((c) => c.shopContractId).filter((s) => s.endsWith(`${tag}.testnet`));
    expect(mine.sort()).toEqual([shops.enabled, shops.open].sort());
  });

  test('provisioning writes the derived key, repairs a forged one, and gives the default vault its env key', async () => {
    await vaults.provisionKeys();
    const rows = await prisma.company.findMany({ where: { id: { in: Object.values(ids) } }, select: { shopContractId: true, testerPublicKey: true } });
    const pk = (shop: string) => rows.find((r) => r.shopContractId === shop)?.testerPublicKey;
    const seed = Buffer.from(SEED_HEX, 'hex');
    if (process.env.TESTER_KEY_SEED === SEED_HEX) {
      expect(pk(shops.enabled)).toBe(testerKeyFor(seed, 'testnet', shops.enabled).getPublicKey().toString());
      expect(pk(shops.idle)).toBe(testerKeyFor(seed, 'testnet', shops.idle).getPublicKey().toString());
    }
    expect(new Set([pk(shops.enabled), pk(shops.open), pk(shops.idle)]).size).toBe(3);
    if (ids[defaultShop]) expect(pk(defaultShop)).toBe(KeyPair.fromString(defaultKey as `ed25519:${string}`).getPublicKey().toString());
    expect(await vaults.provisionKeys()).toBe(0); // nothing changes on a second pass
  });

  test('a recorded state lands on the company row', async () => {
    const ctx = { companyId: ids[shops.enabled], state: null } as unknown as Parameters<typeof vaults.setState>[0];
    await vaults.setState(ctx, 'unarmed');
    const row = await prisma.company.findUnique({ where: { id: ids[shops.enabled] }, select: { testerState: true, testerCheckedAt: true } });
    expect(row?.testerState).toBe('unarmed');
    expect(row?.testerCheckedAt).toBeInstanceOf(Date);
  });
});
