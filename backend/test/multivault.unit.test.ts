import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseShopHeader } from '../src/utils/ids.ts';
import { checkSelfServe, type RegistrationDeps } from '../src/lib/registration.ts';
import { checkEnable, isCommitCron, type EnableDeps } from '../src/lib/testerOnboarding.ts';
import { createRegistry, pickRoundRobin } from '../src/lib/vaults.ts';
import type { AccountState, VaultChain } from '../src/lib/vault/plan.ts';
import { TESTER_METHODS } from '../src/lib/proof/testerKey.ts';

// Multi-vault (backend/README.md, Multiple vaults), no database and no network.
const HASH = '5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs';
const DEFAULT = 'shop4.ss-owner-e9c3db.testnet';
const VAULT = 'acme.alice.testnet';
const ALICE = 'alice.testnet';
const TOKEN = 'tusdc.testnet';

const acct = (globalCodeHash: string | null): AccountState => ({ amount: 10n ** 24n, locked: 0n, storageUsage: 600, codeHash: '11111111111111111111111111111111', globalCodeHash });
const chainWith = (o: { account?: AccountState | null; views?: Record<string, unknown>; keys?: Record<string, unknown[]> } = {}): VaultChain => ({
  account: async (id) => (id === VAULT ? (o.account === undefined ? acct(HASH) : o.account) : null),
  globalCodePublished: async () => true,
  view: async <T>(c: string, m: string) => ((o.views ?? {})[`${c}.${m}`] ?? null) as T | null,
  accessKeys: async (id) => (o.keys?.[id] ?? []) as never,
});
const vaultViews = (owner = ALICE) => ({
  [`${VAULT}.get_status`]: { owner_id: owner, vendor_id: 'agentco.testnet', token_id: TOKEN, mode: 'Unarmed', version: '2.3.0' },
  [`${VAULT}.get_scorecard`]: { score_bps: null },
  [`${VAULT}.get_policy`]: { batch_size: 3 },
  [`${TOKEN}.ft_metadata`]: { symbol: 'tUSDC', decimals: 6 },
});

describe('X-Shop header', () => {
  test('absent is the default vault; one valid lowercase account id is that vault; anything else is refused', () => {
    expect(parseShopHeader(undefined, DEFAULT)).toBe(DEFAULT);
    expect(parseShopHeader(VAULT, DEFAULT)).toBe(VAULT);
    for (const bad of ['', 'Acme.alice.testnet', 'a..b', ' acme.testnet', ['a.testnet', 'b.testnet'], 'x'.repeat(65)]) expect(parseShopHeader(bad, DEFAULT)).toBeNull();
  });
});

describe('self-serve registration checks', () => {
  const deps = (over: Partial<RegistrationDeps> = {}): RegistrationDeps => ({
    chain: chainWith({ views: vaultViews() }),
    codeHash: HASH,
    firstReceivedTx: async () => ({ hash: 'CreatedTx1', blockHeight: 277_912_346 }),
    registered: async () => false,
    companiesOf: async () => 0,
    maxCompanies: 5,
    ...over,
  });
  const user = { id: 'u1', wallet: ALICE };

  test('success stores blockHeight - 1 and the creation tx hash; the vendor comes from the vault', async () => {
    expect(await checkSelfServe(VAULT, user, deps())).toEqual({ ok: true, vendorAccountId: 'agentco.testnet', deployBlock: 277_912_345n, createdTxHash: 'CreatedTx1' });
  });

  test('missing 404, other code 422, never initialized 422, wrong owner 403', async () => {
    expect(await checkSelfServe(VAULT, user, deps({ chain: chainWith({ account: null }) }))).toMatchObject({ ok: false, status: 404 });
    expect(await checkSelfServe(VAULT, user, deps({ chain: chainWith({ account: acct('Other'), views: vaultViews() }) }))).toMatchObject({ ok: false, status: 422, code: 'NOT_A_VAULT' });
    expect(await checkSelfServe(VAULT, user, deps({ chain: chainWith({}) }))).toMatchObject({ ok: false, status: 422, code: 'NOT_A_VAULT' });
    expect(await checkSelfServe(VAULT, user, deps({ chain: chainWith({ views: vaultViews('mallory.testnet') }) }))).toMatchObject({ ok: false, status: 403 });
  });

  test('token without ft_metadata 422; registered 409; over the per-user limit 409; not indexed yet 503', async () => {
    const noMeta = { ...vaultViews() } as Record<string, unknown>;
    delete noMeta[`${TOKEN}.ft_metadata`];
    expect(await checkSelfServe(VAULT, user, deps({ chain: chainWith({ views: noMeta }) }))).toMatchObject({ ok: false, status: 422, code: 'TOKEN_UNSUPPORTED' });
    expect(await checkSelfServe(VAULT, user, deps({ registered: async () => true }))).toMatchObject({ ok: false, status: 409, code: 'CONFLICT' });
    expect(await checkSelfServe(VAULT, user, deps({ companiesOf: async () => 5 }))).toMatchObject({ ok: false, status: 409, code: 'COMPANY_LIMIT' });
    expect(await checkSelfServe(VAULT, user, deps({ firstReceivedTx: async () => null }))).toMatchObject({ ok: false, status: 503, code: 'VAULT_NOT_INDEXED' });
  });
});

describe('commit cron', () => {
  test('M H * * * only: at most hourly, no day fields', () => {
    for (const ok of ['0 */6 * * *', '15 3 * * *', '5 0,12 * * *', '59 1-5 * * *']) expect(isCommitCron(ok)).toBe(true);
    for (const bad of ['* * * * *', '*/5 * * * *', '0 0 1 * *', '0 0 * * 1', '0 0 * 1 *', '60 0 * * *', '0 0 * *', 'garbage', '0 0 * * * *', '0 25 * * *']) expect(isCommitCron(bad)).toBe(false);
  });
});

describe('tester enable checks', () => {
  const PK = 'ed25519:TesterKeyForAcme';
  const goodKey = { public_key: PK, access_key: { nonce: 0, permission: { FunctionCall: { receiver_id: VAULT, method_names: [...TESTER_METHODS], allowance: (10n ** 24n).toString() } } } };
  const deps = (over: Partial<EnableDeps> = {}): EnableDeps => ({
    chain: chainWith({ views: vaultViews(), keys: { [ALICE]: [goodKey] } }),
    shop: VAULT,
    publicKey: PK,
    vendorCount: 1,
    enabledOthers: 0,
    minAllowanceYocto: 10n ** 23n,
    maxBatchSize: 10,
    maxVaults: 10,
    ...over,
  });

  test('ok returns the on-chain owner as signer', async () => {
    expect(await checkEnable(deps())).toEqual({ ok: true, signerId: ALICE });
  });

  test('provisioning, key states, no vendors, batch too large, full', async () => {
    expect(await checkEnable(deps({ publicKey: null }))).toMatchObject({ ok: false, status: 422, code: 'provisioning' });
    expect(await checkEnable(deps({ chain: chainWith({ views: vaultViews(), keys: {} }) }))).toMatchObject({ ok: false, status: 422, code: 'key_missing' });
    const unlimited = { ...goodKey, access_key: { permission: { FunctionCall: { ...goodKey.access_key.permission.FunctionCall, allowance: null } } } };
    expect(await checkEnable(deps({ chain: chainWith({ views: vaultViews(), keys: { [ALICE]: [unlimited] } }) }))).toMatchObject({ code: 'allowance_unlimited' });
    expect(await checkEnable(deps({ vendorCount: 0 }))).toMatchObject({ ok: false, status: 422, code: 'no_vendors' });
    expect(await checkEnable(deps({ maxBatchSize: 2 }))).toMatchObject({ ok: false, status: 422, code: 'policy_unsupported' });
    expect(await checkEnable(deps({ enabledOthers: 10 }))).toMatchObject({ ok: false, status: 409, code: 'TESTER_FULL' });
  });
});

describe('vault registry', () => {
  test('default vault first, cached until invalidated', async () => {
    let loads = 0;
    const rows = [
      { id: 'c1', shopContractId: 'a.testnet', deployBlock: 5n, testerEnabled: true },
      { id: 'c2', shopContractId: DEFAULT, deployBlock: 1n, testerEnabled: false },
    ];
    const r = createRegistry(DEFAULT, async () => (loads++, rows));
    expect((await r.list()).map((v) => [v.shop, v.isDefault])).toEqual([
      [DEFAULT, true],
      ['a.testnet', false],
    ]);
    await r.list();
    expect(loads).toBe(1);
    r.invalidate();
    await r.list();
    expect(loads).toBe(2);
  });

  test('round robin visits every vault in turn and wraps', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    const first = pickRoundRobin(list, 0, 2);
    const second = pickRoundRobin(list, first.next, 2);
    const third = pickRoundRobin(list, second.next, 2);
    expect([first.picked, second.picked, third.picked]).toEqual([['a', 'b'], ['c', 'd'], ['e', 'a']]);
    expect(pickRoundRobin(list, 3, 10).picked).toEqual(['d', 'e', 'a', 'b', 'c']);
    expect(pickRoundRobin([], 7, 3)).toEqual({ picked: [], next: 0 });
  });
});

// inboxAuth and CORS through the real app, no database: the env token never needs one.
describe('inbox auth and CORS without a database', () => {
  test('database down: the env token still works, malformed tokens are 401, a well-formed company token is 503 (never accepted, never 500); X-Shop is an allowed CORS header', async () => {
    const app = resolve(import.meta.dir, '../src/app.ts');
    const reqs = [
      { method: 'GET', url: '/inbox/whoami', headers: { authorization: 'Bearer env-token' } },
      { method: 'GET', url: '/inbox/whoami' },
      { method: 'GET', url: '/inbox/whoami', headers: { authorization: 'Bearer ' } },
      { method: 'GET', url: '/inbox/whoami', headers: { authorization: 'Bearer other' } },
      { method: 'GET', url: '/inbox/whoami', headers: { authorization: `Bearer ssi_${'A'.repeat(43)}` } },
      { method: 'POST', url: '/inbox/blocklist', headers: { authorization: 'Bearer env-token' }, payload: { accountId: 'x.testnet', extra: 1 } },
      { method: 'OPTIONS', url: '/company/me', headers: { origin: 'http://localhost:3200', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,x-shop' } },
    ];
    const script = `const { buildApp } = await import(${JSON.stringify(app)}); const a = await buildApp(); const out = [];
      for (const r of ${JSON.stringify(reqs)}) { const res = await a.inject(r); out.push({ status: res.statusCode, body: res.body ? (() => { try { return JSON.parse(res.body); } catch { return null; } })() : null, allow: res.headers['access-control-allow-headers'] ?? null }); }
      process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n'); process.exit(0);`;
    const p = Bun.spawn(['bun', '-e', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
        JWT_SECRET: 'x'.repeat(32),
        SHOP_CONTRACT_ID: DEFAULT,
        INBOX_TOKEN_HASH: createHash('sha256').update('env-token').digest('hex'),
        CORS_ORIGINS: 'http://localhost:3200',
      },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    const [env, none, empty, other, wellFormed, strictBody, cors] = JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7));
    expect(env.status).toBe(200);
    expect(env.body.data).toEqual({ shop: DEFAULT });
    expect([none.status, empty.status, other.status]).toEqual([401, 401, 401]);
    expect(wellFormed.status).toBe(503);
    expect(wellFormed.body.error.code).toBe('INBOX_UNAVAILABLE');
    expect(strictBody.status).toBe(400); // an authenticated caller still gets the strict-body check
    expect(String(cors.allow).toLowerCase()).toContain('x-shop');
  }, 30_000);
});
