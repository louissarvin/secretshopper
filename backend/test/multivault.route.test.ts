import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TESTER_METHODS } from '../src/lib/proof/testerKey.ts';

// v2/37 package A against Postgres (TEST_DATABASE_URL, a disposable database). Chain and FastNEAR tx API are a local
// stand-in; the app runs in test/helpers/multivault.scenario.ts in its own process.
const DB = process.env.TEST_DATABASE_URL;
const HASH = '5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs';
const tag = randomBytes(4).toString('hex');
const ALICE = `alice-${tag}.testnet`;
const BOB = `bob-${tag}.testnet`;
const DEFAULT = `ss-mv-${tag}.testnet`;
const A2 = `a2.${ALICE}`;
const B1 = `b1.${BOB}`;
const TOKEN = 'tusdc.testnet';
const TESTER_PK = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
const ENV_TOKEN = 'env-token-' + tag;
const OWNER: Record<string, string> = { [DEFAULT]: ALICE, [A2]: ALICE, [B1]: BOB };

describe.skipIf(!DB)('multi-vault routes with Postgres', () => {
  let server: ReturnType<typeof Bun.serve>;
  let r: Record<string, any>;

  beforeAll(async () => {
    const enc = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
    const block = { block_height: 1, block_hash: '11111111111111111111111111111111' };
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        const body = (await req.json()) as { id?: unknown; params?: Record<string, string>; account_id?: string };
        if (path === '/v0/account') return Response.json({ account_txs: OWNER[body.account_id!] ? [{ transaction_hash: `Created-${body.account_id}`, tx_block_height: 1000 }] : [] });
        if (path === '/v0/transactions') return Response.json({ transactions: [] });
        const q = body.params!;
        const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result });
        if (q.request_type === 'view_account') {
          if (!OWNER[q.account_id])
            return Response.json({ jsonrpc: '2.0', id: body.id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: q.account_id, ...block } }, code: -32000, message: 'Server error' } });
          return ok({ amount: '1000000000000000000000000', locked: '0', code_hash: '11111111111111111111111111111111', global_contract_hash: HASH, storage_usage: 600, storage_paid_at: 0, ...block });
        }
        if (q.request_type === 'view_access_key_list') {
          const keys = q.account_id === ALICE ? [{ public_key: TESTER_PK, access_key: { nonce: 0, permission: { FunctionCall: { receiver_id: A2, method_names: [...TESTER_METHODS], allowance: '1000000000000000000000000' } } } }] : [];
          return ok({ keys, ...block });
        }
        if (q.request_type === 'call_function') {
          const views: Record<string, unknown> = {
            get_status: { mode: 'Unarmed', agent_key: null, pending_key: null, armed_at: '0', demoted_at: '0', spent_24h: '0', version: '2.3.0', owner_id: OWNER[q.account_id], vendor_id: 'agentco.testnet', token_id: TOKEN, intents_id: null },
            get_scorecard: { mode: 'Unarmed', agent_key: null, stats: {}, score_bps: null, pending: 0, overdue_unrevealed: 0, spent_24h: '0', now: '1' },
            get_policy: { batch_size: 3, batch_interval: '1', key_allowance: '1', key_nonces: 0 },
            ft_metadata: { symbol: 'tUSDC', decimals: 6 },
            get_decision: null,
          };
          return ok({ result: enc(views[q.method_name] ?? null), logs: [], ...block });
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR', info: { error_message: 'unsupported' } }, code: -32700, message: 'Parse error' } });
      },
    });
    const url = `http://127.0.0.1:${server.port}`;
    const p = Bun.spawn(['bun', resolve(import.meta.dir, 'helpers/multivault.scenario.ts')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LOG_LEVEL: 'silent',
        DATABASE_URL: DB!,
        JWT_SECRET: randomBytes(32).toString('hex'),
        SHOP_CONTRACT_ID: DEFAULT,
        INBOX_TOKEN_HASH: createHash('sha256').update(ENV_TOKEN).digest('hex'),
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: url,
        NEAR_RPC_URLS: url, // Bun loads backend/.env from cwd; keep every chain read local
        NEAR_TX_API_URL: url,
        VAULT_CODE_HASH: HASH,
        MV_TAG: tag,
        MV_A2: A2,
        MV_B1: B1,
        MV_ALICE: ALICE,
        MV_BOB: BOB,
        MV_ENV_TOKEN: ENV_TOKEN,
        MV_TESTER_PK: TESTER_PK,
      },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(err.slice(-3000));
    r = JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7));
  }, 120_000);
  afterAll(() => server?.stop(true));

  test('registration: legacy default, self-serve with derived deploy block and creation tx, refusals', () => {
    expect(r.regDefault.status).toBe(201);
    expect(r.regDefault.body.data).toMatchObject({ shopContractId: DEFAULT, isDefault: true, createdTxHash: null, deployBlock: '1' });
    expect(r.regA2.status).toBe(201);
    expect(r.regA2.body.data).toMatchObject({ shopContractId: A2, isDefault: false, deployBlock: '999', createdTxHash: `Created-${A2}`, vendorAccountId: 'agentco.testnet', inboxTokenSet: false, tester: { enabled: false, testPercent: 50, commitCron: null, publicKey: null, state: null } });
    expect(r.regA2Again.status).toBe(409);
    expect(r.regA2ByBob.status).toBe(403);
    expect(r.regB1WithBlock.status).toBe(400);
    expect(r.regB1.status).toBe(201);
    expect(r.regUnknown.status).toBe(404);
  });

  test('/company/mine lists only the caller, never an inbox hash; /company/me follows X-Shop', () => {
    expect(r.mineA.body.data.items.map((c: { shopContractId: string }) => c.shopContractId)).toEqual([DEFAULT, A2]);
    expect(r.mineB.body.data.items.map((c: { shopContractId: string }) => c.shopContractId)).toEqual([B1]);
    expect(JSON.stringify(r.mineAfterToken)).not.toContain('inboxTokenHash');
    expect(r.mineAfterToken.body.data.items.find((c: { shopContractId: string }) => c.shopContractId === A2).inboxTokenSet).toBe(true);
    expect(r.meDefault.body.data.shopContractId).toBe(DEFAULT);
    expect(r.meA2.body.data.shopContractId).toBe(A2);
    expect(r.meBad.status).toBe(400);
  });

  test('cross tenant: on every owner route another owner\'s vault is 403, unknown 404, malformed 400, and B has no default vault', () => {
    for (const [route, codes] of Object.entries(r.matrix as Record<string, number[]>)) expect([route, ...codes]).toEqual([route, 403, 404, 400, 403]);
    expect(Object.keys(r.matrix)).toHaveLength(11);
    expect(r.vendorsDefault.status).toBe(200);
    expect(r.vendorsA2.status).toBe(200);
  });

  test('every route behind authMiddleware also requires the company owner, except the allowlist', () => {
    const allow = new Set(['GET /company/me', 'GET /company/mine', 'POST /company/', 'POST /company']);
    const authed = (r.routes as { method: string; url: string; pre: string[] }[]).filter((x) => x.pre.includes('authMiddleware') && x.method !== 'HEAD');
    expect(authed.length).toBeGreaterThan(10);
    for (const x of authed) {
      const key = `${x.method} ${x.url}`;
      if (allow.has(key)) continue;
      if (x.url.startsWith('/vendor/')) expect([key, x.pre.includes('requireVendor') || x.url === '/vendor/vaults']).toEqual([key, true]);
      else expect([key, x.pre.includes('requireCompanyOwner')]).toEqual([key, true]);
    }
  });

  test('inbox: a vault token sees only its vault; the env token only the default; rotation kills the old token', () => {
    expect(r.tokenIssued.status).toBe(201);
    expect(r.tokenIssued.body.data.token).toMatch(/^ssi_[A-Za-z0-9_-]{43}$/);
    expect(r.tokenIssued.body.data.shopContractId).toBe(A2);
    expect(r.whoamiA2.body.data).toEqual({ shop: A2 });
    expect(r.whoamiEnv.body.data).toEqual({ shop: DEFAULT });
    expect(r.nextA2.body.data.id).toBe('a'.repeat(64));
    expect(r.nextEnv.body.data.id).toBe('d'.repeat(64));
    expect(r.vendorOwn.status).toBe(200);
    expect(r.vendorForeign.status).toBe(404);
    expect(r.wrongToken.status).toBe(401);
    expect(r.oldTokenAfterRotate.status).toBe(401);
    expect(r.newTokenAfterRotate.body.data).toEqual({ shop: A2 });
  });

  test('blocklist: an agent counts its own vault and the trusted default, never an untrusted foreign vault', () => {
    const vaults = (x: { body: { data: { entries: { vault: string }[] } } }) => x.body.data.entries.map((e) => e.vault).sort();
    expect(vaults(r.blockA2)).toEqual([A2, DEFAULT].sort());
    expect(vaults(r.blockEnv)).toEqual([DEFAULT]);
    expect(vaults(r.blockPublic)).toEqual([A2, B1, DEFAULT].sort());
  });

  test('tester onboarding: provisioning, enable with key checks, cron rules, default vault stays in env', () => {
    expect(r.testerPublicBefore.body.data).toEqual({
      shopId: A2,
      signerId: ALICE,
      publicKey: null,
      receiverId: A2,
      methods: [...TESTER_METHODS],
      allowanceYocto: '1000000000000000000000000',
      minAllowanceYocto: '100000000000000000000000',
      enabled: false,
      state: 'provisioning',
    });
    expect(r.enableBeforeKey.status).toBe(422);
    expect(r.enableBeforeKey.body.error.code).toBe('provisioning');
    expect(r.enable.status).toBe(200);
    expect(r.enable.body.data).toMatchObject({ enabled: true, testPercent: 30, commitCron: '15 */6 * * *', publicKey: TESTER_PK });
    expect(r.badCron.status).toBe(400);
    expect(r.enableDefault.status).toBe(409);
    expect(r.enableDefault.body.error.code).toBe('DEFAULT_VAULT_ENV');
    expect(r.testerOwner.body.data).toMatchObject({ enabled: true, testPercent: 30, signerId: ALICE });
    expect(r.disable.body.data.enabled).toBe(false);
    // disabling keeps the settings and the signer; the API never wrote the tester-owned state columns
    expect(r.a2Row).toMatchObject({ testerEnabled: false, testerSignerId: ALICE, testPercent: 30, commitCron: '15 */6 * * *', testerState: null, testerCheckedAt: null });
    expect(r.a2Row.testerEnabledAt).not.toBeNull();
  });

  test('projector: each vault projects into its own company; a malformed row in one stays and blocks nothing', () => {
    expect(r.projected).toEqual([1, 1]);
    expect(r.payments).toEqual({ a2: [{ paymentId: 7 }], b1: [{ paymentId: 8 }] });
    expect(r.stuck).toBe(1);
  });
});

// Static, no database: API code never writes the columns only the tester process owns.
describe('tester-owned columns', () => {
  test('no file outside src/tester sets testerPublicKey, testerState or testerCheckedAt', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'tester' ? [] : walk(join(d, e.name))) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
    for (const f of walk(resolve(import.meta.dir, '../src'))) {
      // an object key set to anything but a select flag, a read of the same field (`c.x`) or a type annotation
      const hits = readFileSync(f, 'utf8').match(/\b(testerPublicKey|testerState|testerCheckedAt):\s*(?!true\b|c\.\1\b|string\b|Date\b)\S+/g) ?? [];
      expect([f, hits]).toEqual([f, []]);
    }
  });
});
