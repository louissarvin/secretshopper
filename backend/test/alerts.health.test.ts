import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { healthActivity, healthAlert, STALL_COMMIT, STALL_RELEASE, type Alert, type HealthKind } from '../src/lib/alerts/map.ts';
import { commitStalled, overfundedMicroNear, releaseStallAgeMs, releaseStalled, shouldFire, stallBits } from '../src/lib/alerts/health.ts';
import { assertTestDatabase } from './dbGuard.ts';
import { createEventRunner, createHealthRunner, OVERLAP_MS, type EventStore, type HealthState, type HealthStore, type StoredRow } from '../src/lib/alerts/runner.ts';

const ctx = { vault: 'shop4.ss-owner-e9c3db.testnet', network: 'testnet' };
const V = ctx.vault;
const MIN = 60_000;
const HOUR = 60 * MIN;
const NEAR = 10n ** 24n;
const now = Date.UTC(2026, 10, 13, 12, 0);

describe('health rules', () => {
  test('a delivered tick needs a release within two ticks (at least 15 min), and only recent ticks count', () => {
    expect(releaseStallAgeMs(120)).toBe(4 * HOUR);
    expect(releaseStallAgeMs(1)).toBe(15 * MIN); // indexer lag floor
    const base = { posted: false, nowMs: now, tickMinutes: 120 };
    expect(releaseStalled({ ...base, tickMs: now - 4 * HOUR })).toBe(true);
    expect(releaseStalled({ ...base, tickMs: now - 4 * HOUR + 1 })).toBe(false);
    expect(releaseStalled({ ...base, tickMs: now - 4 * HOUR, posted: true })).toBe(false);
    expect(releaseStalled({ ...base, tickMs: now - 25 * HOUR })).toBe(false);
    expect(releaseStalled({ ...base, tickMs: null })).toBe(false);
  });

  test('an armed vault with no batch for batch_interval plus 1 h is stalled; counting from the arming if later', () => {
    const p = { armed: true, lastBatchMs: now - 25 * HOUR - 1, armedAtMs: 0, intervalMs: 24 * HOUR, chainNowMs: now };
    expect(commitStalled(p)).toBe(true);
    expect(commitStalled({ ...p, lastBatchMs: now - 25 * HOUR })).toBe(false);
    expect(commitStalled({ ...p, armed: false })).toBe(false);
    expect(commitStalled({ ...p, armedAtMs: now - HOUR })).toBe(false);
    expect(commitStalled({ ...p, lastBatchMs: null, armedAtMs: now - 26 * HOUR })).toBe(true);
  });

  test('a gas key counts as overfunded above key_allowance plus 10%, reported in microNEAR', () => {
    const allowance = NEAR / 2n;
    expect(overfundedMicroNear([NEAR / 2n, (allowance * 11n) / 10n], allowance)).toBe(0n);
    expect(overfundedMicroNear([(allowance * 11n) / 10n + 1n, NEAR + 5n * 10n ** 18n], allowance)).toBe(1_000_005n);
    expect(overfundedMicroNear([], allowance)).toBe(0n);
  });

  test('alerts fire on change only: a higher overdue count, a new stall reason, a key newly overfunded', () => {
    expect(shouldFire('reveal_overdue', 0n, 2n)).toBe(true);
    expect(shouldFire('reveal_overdue', 2n, 2n)).toBe(false);
    expect(shouldFire('reveal_overdue', 2n, 1n)).toBe(false);
    expect(shouldFire('reveal_overdue', 1n, 3n)).toBe(true);
    expect(shouldFire('tester_stalled', 0n, STALL_RELEASE)).toBe(true);
    expect(shouldFire('tester_stalled', STALL_RELEASE, STALL_RELEASE)).toBe(false);
    expect(shouldFire('tester_stalled', STALL_RELEASE, stallBits(true, true))).toBe(true);
    expect(shouldFire('tester_stalled', stallBits(true, true), STALL_COMMIT)).toBe(false);
    expect(shouldFire('gas_key_overfunded', 0n, 1n)).toBe(true);
    expect(shouldFire('gas_key_overfunded', 1n, 2n)).toBe(false);
  });

  test('health items share the activity shape and the webhook text', () => {
    const since = new Date(now);
    expect(healthActivity('reveal_overdue', 2n, since, ctx)).toEqual({
      id: `health:reveal_overdue:${now}`,
      kind: 'reveal_overdue',
      at: since.toISOString(),
      text: `2 test slots are past expiry and reveal grace on ${V} but still unrevealed. Check the tester, or reveal with scripts/keeper.ts.`,
      txHash: null,
      slot: null,
      proposalId: null,
      event: 'health',
      blockHeight: null,
    });
    expect(healthActivity('reveal_overdue', 1n, since, ctx).text).toStartWith('1 test slot is past');
    expect(healthActivity('tester_stalled', STALL_RELEASE | STALL_COMMIT, since, ctx).text).toBe(
      `Tester looks stalled on ${V}: no release root was posted for a delivery tick two ticks old and no test batch was committed within batch_interval plus 1 h while the agent is armed. Check the tester process, its key and its NEAR balance.`
    );
    expect(healthActivity('tester_stalled', STALL_COMMIT, since, ctx).text).toContain(': no test batch was committed');
    expect(healthActivity('gas_key_overfunded', 1_000_005n, since, ctx).text).toContain('holds 1.000005 NEAR, more than key_allowance plus 10%');
    const a = healthAlert('gas_key_overfunded', 1_000_005n, since, ctx);
    expect(a).toMatchObject({ type: 'gas_key_overfunded', vault: V, data: { value: '1000005' }, content: a.text });
  });
});

const memHealth = (): HealthStore & { rows: Map<HealthKind, HealthState> } => {
  const rows = new Map<HealthKind, HealthState>();
  let t = now;
  return {
    rows,
    load: async () => new Map(rows),
    save: async (kind, value) => {
      const since = new Date((t += MIN));
      rows.set(kind, { value, since });
      return since;
    },
  };
};

describe('health runner', () => {
  test('persists every change, sends only on firing changes, and leaves unknown readings alone', async () => {
    const store = memHealth();
    const sent: Alert[] = [];
    const runner = createHealthRunner({ store, context: () => ctx, send: async (a) => void sent.push(a) });
    expect(await runner.apply({ reveal_overdue: 2n, tester_stalled: 0n, gas_key_overfunded: 0n })).toEqual(['reveal_overdue']);
    expect(await runner.apply({ reveal_overdue: 2n, tester_stalled: 0n })).toEqual([]); // same state: nothing
    expect(await runner.apply({ reveal_overdue: 1n })).toEqual([]); // fewer overdue: stored, silent
    expect(store.rows.get('reveal_overdue')!.value).toBe(1n);
    expect(await runner.apply({ reveal_overdue: 3n, tester_stalled: STALL_COMMIT })).toEqual(['reveal_overdue', 'tester_stalled']);
    expect(await runner.apply({ reveal_overdue: undefined, tester_stalled: undefined })).toEqual([]); // RPC down: no change
    expect(store.rows.get('tester_stalled')!.value).toBe(STALL_COMMIT);
    expect(sent.map((a) => [a.type, a.data.value])).toEqual([
      ['reveal_overdue', '2'],
      ['reveal_overdue', '3'],
      ['tester_stalled', '2'],
    ]);
  });

  test('without webhooks it still records state for the feed', async () => {
    const store = memHealth();
    const runner = createHealthRunner({ store, context: () => ctx, send: null });
    expect(await runner.apply({ gas_key_overfunded: 1_200_000n })).toEqual(['gas_key_overfunded']);
    expect(store.rows.get('gas_key_overfunded')!.value).toBe(1_200_000n);
  });
});

const PK = 'ed25519:HYnC71oRwPTVR2h2FBBphebpA4RKube17Qq4KKDrAyUh';

/** ContractEvent rows in memory, with the same filters the Prisma store applies. */
const memEvents = () => {
  const rows: StoredRow[] = [];
  let cursor: number | null = null;
  let n = 0;
  const add = (createdAt: number, event = 'agent_demoted') =>
    rows.push({ id: `e${n++}`, txHash: 't', blockHeight: 1n, blockTime: new Date(createdAt), event, data: { slot_id: n, public_key: PK }, createdAt: new Date(createdAt) });
  const store: EventStore = {
    loadCursor: async () => cursor,
    saveCursor: async (ms) => void (cursor = ms),
    newestCreatedAt: async () => (rows.length ? Math.max(...rows.map((r) => r.createdAt.getTime())) : null),
    idsBetween: async (a, b) => rows.filter((r) => r.createdAt.getTime() >= a && r.createdAt.getTime() <= b).map((r) => ({ id: r.id, createdAt: r.createdAt.getTime() })),
    fetch: async (from, exclude, take, events) =>
      rows
        .filter((r) => r.createdAt.getTime() >= from && !exclude.includes(r.id) && events.includes(r.event))
        .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id))
        .slice(0, take),
  };
  return { store, add, cursor: () => cursor };
};

describe('event runner cursor', () => {
  const runner = (store: EventStore, sent: string[]) => createEventRunner({ store, context: async () => ctx, send: async (a) => void sent.push(a.id) });

  test('the first start skips history and saves a cursor; later rows are sent once', async () => {
    const m = memEvents();
    m.add(now - HOUR);
    m.add(now);
    const sent: string[] = [];
    const r = runner(m.store, sent);
    expect(await r.tick()).toBe(0);
    expect(m.cursor()).toBe(now);
    m.add(now + MIN);
    m.add(now + MIN, 'paid'); // not alert-worthy
    expect(await r.tick()).toBe(1);
    expect(await r.tick()).toBe(0);
    expect(sent).toEqual(['e2']);
    expect(m.cursor()).toBe(now + MIN);
  });

  test('a restart replays what arrived while the API was down, and nothing it already sent', async () => {
    const m = memEvents();
    m.add(now);
    const sent: string[] = [];
    await runner(m.store, sent).tick(); // first start
    m.add(now + 10_000);
    await runner(m.store, sent).tick(); // sent e1, cursor saved
    expect(sent).toEqual(['e1']);
    m.add(now + 20_000); // API down
    m.add(now + 5 * MIN);
    const restarted = runner(m.store, sent);
    expect(await restarted.tick()).toBe(2);
    expect(sent).toEqual(['e1', 'e2', 'e3']);
  });

  test('a row committed late with an earlier createdAt is still sent within the overlap window', async () => {
    const m = memEvents();
    m.add(now);
    const sent: string[] = [];
    const r = runner(m.store, sent);
    await r.tick();
    m.add(now + 30_000);
    await r.tick();
    m.add(now + 30_000 - OVERLAP_MS / 2); // slower insert, earlier timestamp
    expect(await r.tick()).toBe(1);
    expect(sent).toEqual(['e1', 'e2']);
  });
});

// Real DB (a disposable test schema): the ChainCursor stores and the feed's health array.
const DB = process.env.TEST_DATABASE_URL;
const tag = randomBytes(4).toString('hex');

describe.skipIf(!DB)('alert stores and health feed (Postgres)', () => {
  let app: FastifyInstance;
  let prisma: typeof import('../src/lib/prisma.ts').prismaQuery;
  let stores: typeof import('../src/lib/alerts/stores.ts');
  let shop = '';
  let secret = '';
  let ownerId = '';
  let companyId = '';
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
    stores = await import('../src/lib/alerts/stores.ts');
    app = await (await import('../src/app.ts')).buildApp();
    ownerId = (await prisma.user.create({ data: { walletAddress: `owner-h-${tag}.testnet` } })).id;
    companyId = (await prisma.company.create({ data: { ownerUserId: ownerId, name: 'Health Co', shopContractId: shop, vendorAccountId: 'v.testnet', deployBlock: 1n } })).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    if (!guarded) return void (await prisma.$disconnect());
    await prisma.chainCursor.deleteMany({ where: { id: { in: [`alerts:${shop}`, ...['reveal_overdue', 'tester_stalled', 'gas_key_overfunded'].map((k) => `health:${shop}:${k}`)] } } });
    await prisma.contractEvent.deleteMany({ where: { contractId: shop } });
    await prisma.contractEvent.deleteMany({ where: { receiptId: { startsWith: `h-${tag}-` } } });
    if (companyId) await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.user.deleteMany({ where: { walletAddress: { endsWith: `-${tag}.testnet` } } });
    await app?.close();
    await prisma.$disconnect();
  });

  test('the event cursor survives in ChainCursor, so a new runner replays only what it missed', async () => {
    const store = stores.eventStore(shop);
    const add = (i: number) =>
      prisma.contractEvent.create({
        data: { receiptId: `h-${tag}-${i}`, logIndex: 0, txHash: `t${i}`, blockHeight: BigInt(i), blockTime: new Date(), contractId: shop, standard: 'secret_shopper', version: '2.3.0', event: 'agent_demoted', data: { slot_id: i, public_key: PK } },
      });
    await add(1);
    const sent: string[] = [];
    const mk = () => createEventRunner({ store, context: async () => ctx, send: async (a) => void sent.push(String(a.data.slot_id)) });
    await mk().tick();
    expect(sent).toEqual([]);
    expect(await store.loadCursor()).not.toBeNull();
    await Bun.sleep(5);
    await add(2);
    await mk().tick(); // a fresh runner is a restart
    expect(sent).toEqual(['2']);
  });

  test('health state round-trips and active conditions show in /company/alerts', async () => {
    const store = stores.healthStore(shop);
    const runner = createHealthRunner({ store, context: () => ctx, send: null });
    await runner.apply({ reveal_overdue: 2n, tester_stalled: 0n, gas_key_overfunded: 1_500_000n });
    const loaded = await store.load();
    expect(loaded.get('reveal_overdue')!.value).toBe(2n);
    expect(loaded.has('tester_stalled')).toBe(false); // no state equals 0: an unchanged reading writes nothing
    const token = jwt.sign({ userId: ownerId }, secret, { algorithm: 'HS256', expiresIn: '5m' });
    const res = await app.inject({ method: 'GET', url: '/company/alerts', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const health = res.json().data.health as { kind: string; text: string; event: string }[];
    expect(health.map((h) => h.kind).sort()).toEqual(['gas_key_overfunded', 'reveal_overdue']);
    expect(health.every((h) => h.event === 'health')).toBe(true);
  });
});
