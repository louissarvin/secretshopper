import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildVaultPlan, formatNear, parseNear, scaleDefaultCap, type AccountState, type PlanConfig, type VaultChain } from '../src/lib/vault/plan.ts';
import { checkPolicy, DEFAULT_POLICY, minFunding } from '../src/lib/vault/policy.ts';
import { readVault } from '../src/lib/vault/view.ts';
import { createLru } from '../src/utils/lruCache.ts';

const HASH = '5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs';
const OWNER = 'acme.testnet';
const VENDOR = 'vendor.testnet';
const TOKEN = 'tusdc.testnet';
const NEAR = 10n ** 24n;
const CFG: PlanConfig = { network: 'testnet', codeHash: HASH, defaultTokenId: TOKEN, allowMainnet: false };

const acct = (amount: bigint, extra: Partial<AccountState> = {}): AccountState => ({ amount, locked: 0n, storageUsage: 100, codeHash: '11111111111111111111111111111111', globalCodeHash: null, ...extra });

/** In-memory chain: accounts, contract views and keys; anything else is missing. */
const fakeChain = (o: { accounts?: Record<string, AccountState>; views?: Record<string, unknown>; keys?: Record<string, { public_key: string; access_key: { permission: unknown } }[]>; published?: string[] } = {}): VaultChain & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    account: async (id) => (calls.push(`account:${id}`), o.accounts?.[id] ?? null),
    globalCodePublished: async (h) => (o.published ?? [HASH]).includes(h),
    view: async <T>(c: string, m: string) => (calls.push(`view:${c}.${m}`), (o.views?.[`${c}.${m}`] ?? null) as T | null),
    accessKeys: async (id) => o.keys?.[id] ?? [],
  };
};

const world = () =>
  fakeChain({
    accounts: { [OWNER]: acct(10n * NEAR), [VENDOR]: acct(1n * NEAR) },
    views: {
      [`${TOKEN}.ft_metadata`]: { spec: 'ft-1.0.0', name: 'test USDC', symbol: 'tUSDC', decimals: 6 },
      [`${TOKEN}.storage_balance_bounds`]: { min: '1250000000000000000000', max: '1250000000000000000000' },
    },
  });

const body = (over: Record<string, unknown> = {}) => ({ ownerId: OWNER, name: 'shop', vendorId: VENDOR, fundNear: '1.5', ...over });

const refused = async (input: unknown, chain: VaultChain = world(), cfg = CFG) => {
  const r = await buildVaultPlan(input, cfg, chain);
  if (r.ok) throw new Error('expected a refusal');
  return r;
};

describe('vault policy (moved from scripts/lib/vault-deploy.ts)', () => {
  test('DEFAULT_POLICY equals scripts/fixtures/policy-testnet.json and passes checkPolicy', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, '../../scripts/fixtures/policy-testnet.json'), 'utf8'));
    expect({ ...DEFAULT_POLICY }).toEqual(fixture);
    expect(checkPolicy({ ...DEFAULT_POLICY })).toEqual([]);
  });

  test('V23-14: a gas key holds at most 0.5 NEAR; a classic key keeps only the half-float rule', () => {
    const big = { ...DEFAULT_POLICY, min_near_float: (2n * NEAR).toString() };
    const msg = 'key_allowance must be at most 0.5 NEAR when the agent key is a gas key (V23-14)';
    expect(checkPolicy({ ...big, key_allowance: (NEAR / 2n).toString() })).toEqual([]);
    expect(checkPolicy({ ...big, key_allowance: (NEAR / 2n + 1n).toString() })).toEqual([msg]);
    expect(checkPolicy({ ...big, key_allowance: NEAR.toString() })).toEqual([msg]);
    expect(checkPolicy({ ...big, key_allowance: NEAR.toString(), key_nonces: 0 })).toEqual([]);
  });

  test('V23-14 through the plan: a field error on policy.key_allowance', async () => {
    const r = await refused(body({ fundNear: '5', policy: { key_allowance: '600000000000000000000000', min_near_float: '2000000000000000000000000' } }));
    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.problems).toContainEqual({ field: 'policy.key_allowance', message: 'key_allowance must be at most 0.5 NEAR when the agent key is a gas key (V23-14)' });
  });

  test('minimum funding for the default gas-key policy', () => {
    // 600 B state + 0.5 float + 0.25 gas key + (120 + 4 * 85) B lanes + 0.1 headroom
    expect(minFunding({ kind: 'global', codeHash: new Uint8Array(32) }, { ...DEFAULT_POLICY })).toBe(860_600_000_000_000_000_000_000n);
  });

  test('NEAR amounts convert exactly', () => {
    expect(parseNear('1.5')).toBe(1_500_000_000_000_000_000_000_000n);
    expect(parseNear('0.000000000000000000000001')).toBe(1n);
    expect(formatNear(860_600_000_000_000_000_000_000n)).toBe('0.8606');
    expect(formatNear(2n * NEAR)).toBe('2');
    // messages show at most 4 decimals: owed amounts round up, held balances down
    expect(formatNear(1_501_250_000_000_000_000_000_000n)).toBe('1.5013');
    expect(formatNear(495_312_345_678_901_234_567_890n, 'floor')).toBe('0.4953');
    expect(formatNear(1_250_000_000_000_000_000_000n)).toBe('0.0013');
    expect(formatNear(1n)).toBe('0.0001');
    expect(formatNear(1n, 'floor')).toBe('0');
  });
});

describe('POST /public/vault-plan builder', () => {
  test('a fixture request yields exactly the two ConnectorAction transactions', async () => {
    const r = await buildVaultPlan(body(), CFG, world());
    if (!r.ok) throw new Error(r.problems.join('; '));
    const init = { owner_id: OWNER, vendor_id: VENDOR, token_id: TOKEN, intents_id: null, policy: { ...DEFAULT_POLICY } };
    expect(r.plan.vaultId).toBe(`shop.${OWNER}`);
    expect(r.plan.signerId).toBe(OWNER);
    expect(r.plan.totalYocto).toBe('1501250000000000000000000');
    expect(r.plan.init).toEqual(init);
    expect(r.plan.transactions).toEqual([
      {
        signerId: OWNER,
        receiverId: `shop.${OWNER}`,
        actions: [
          { type: 'CreateAccount' },
          { type: 'Transfer', params: { deposit: '1500000000000000000000000' } },
          { type: 'UseGlobalContract', params: { contractIdentifier: { codeHash: HASH } } },
          { type: 'FunctionCall', params: { methodName: 'new', args: init, gas: '50000000000000', deposit: '0' } },
        ],
      },
      {
        signerId: OWNER,
        receiverId: TOKEN,
        actions: [
          {
            type: 'FunctionCall',
            params: { methodName: 'storage_deposit', args: { account_id: `shop.${OWNER}`, registration_only: true }, gas: '30000000000000', deposit: '1250000000000000000000' },
          },
        ],
      },
    ]);
    expect(r.plan.token).toEqual({ id: TOKEN, symbol: 'tUSDC', decimals: 6 });
    expect(r.plan.minFundingYocto).toBe('860600000000000000000000');
    expect(r.plan.warnings).toEqual([]);
    expect(r.plan.cli[0]).toBe(
      `near transaction construct-transaction ${OWNER} receiver-id shop.${OWNER} add-action create-account add-action transfer '1500000000000000000000000 yoctonear' ` +
        `add-action use-global-contract use-global-hash ${HASH} with-init-call new json-args '${JSON.stringify(init)}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' ` +
        'skip network-config testnet sign-with-legacy-keychain send'
    );
    expect(r.plan.cli[1]).toBe(
      `near contract call-function as-transaction ${TOKEN} storage_deposit json-args '{"account_id":"shop.${OWNER}","registration_only":true}' ` +
        `prepaid-gas '30 Tgas' attached-deposit '1250000000000000000000 yoctonear' sign-as ${OWNER} network-config testnet sign-with-legacy-keychain send`
    );
    expect(r.plan.next.some((n) => n.includes('cli[1]'))).toBe(true);
  });

  test('a policy override merges over the default and changes the init args', async () => {
    const r = await buildVaultPlan(body({ policy: { daily_cap: '9000000', key_nonces: 0 } }), CFG, world());
    if (!r.ok) throw new Error(r.problems.join('; '));
    expect(r.plan.init.policy).toEqual({ ...DEFAULT_POLICY, daily_cap: '9000000', key_nonces: 0 });
  });

  test('bad names are refused before any chain read', async () => {
    for (const name of ['Shop', 'a.b', '-shop', 'shop-', 'sh--op', '', 'x'.repeat(64), 'shop!']) {
      const chain = world();
      const r = await refused(body({ name }), chain);
      expect(r.code).toBe('VALIDATION_ERROR');
      expect([...new Set(r.problems.map((p) => p.field))]).toEqual(['name']);
      expect(chain.calls).toEqual([]);
    }
    // a valid label whose full id passes 64 characters
    const long = await refused(body({ name: 'x'.repeat(60) }));
    expect(long.code).toBe('VALIDATION_ERROR');
    expect(long.problems[0]).toMatchObject({ field: 'name' });
    expect(long.problems[0].message).toContain('not a valid NEAR account id');
  });

  test('unknown fields, bad amounts and bad ids are validation errors', async () => {
    const fields = async (b: unknown) => (await refused(b)).problems.map((p) => p.field);
    expect(await fields(body({ extra: 1 }))).toEqual(['extra']);
    expect(await fields(body({ fundNear: '1e3' }))).toEqual(['fundNear']);
    expect(await fields(body({ fundNear: '-1' }))).toEqual(['fundNear']);
    expect(await fields(body({ vendorId: 'Bad..id' }))).toEqual(['vendorId']);
    expect(await fields(body({ policy: { daily_cap: '1.5' } }))).toEqual(['policy.daily_cap']);
    expect(await fields(body({ policy: { test_ttl: '18446744073709551616' } }))).toEqual(['policy.test_ttl']);
    expect(await fields(body({ policy: { unknown_field: '1' } }))).toEqual(['policy.unknown_field']);
    expect((await refused(body({ extra: 1 }))).malformed).toBe(true);
  });

  test('same owner and vendor is refused', async () => {
    const r = await refused(body({ vendorId: OWNER }));
    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.problems).toEqual([{ field: 'vendorId', message: 'owner and vendor must differ' }]);
  });

  test('funding below the minimum is refused', async () => {
    const r = await refused(body({ fundNear: '0.86' }));
    expect(r.problems).toEqual([{ field: 'fundNear', message: 'fund at least 0.8606 NEAR (storage, reveal float, first gas-key arming and headroom)' }]);
  });

  test('a policy the contract would reject is refused', async () => {
    const lowAnswer = await refused(body({ policy: { min_answer: '1000' } }));
    expect(lowAnswer.problems).toContainEqual({ field: 'policy.min_answer', message: 'min_answer must be positive, at least test_ttl / 4 and below test_ttl' });
    const bigKey = await refused(body({ policy: { key_allowance: '300000000000000000000000' } }));
    expect(bigKey.problems).toContainEqual({ field: 'policy.key_allowance', message: 'key_allowance must be at most half of min_near_float (V21-01)' });
    const lanes = await refused(body({ policy: { key_nonces: 65 } }));
    expect(lanes.problems).toContainEqual({ field: 'policy.key_nonces', message: 'key_nonces must be an integer from 0 (classic key) to 64 (gas key lanes)' });
    expect(lanes.code).toBe('VALIDATION_ERROR');
  });

  test('chain facts: missing accounts, existing vault, unpublished code, token without NEP-145, poor owner', async () => {
    const empty = await refused(body(), fakeChain({ published: [] }));
    expect(empty.code).toBe('VAULT_PLAN_REFUSED'); // the unpublished code is not a field problem
    expect(empty.problems).toEqual([
      { field: 'ownerId', message: `owner ${OWNER} does not exist on testnet` },
      { field: 'vendorId', message: `vendor ${VENDOR} does not exist on testnet` },
      { message: `no global contract with hash ${HASH} on testnet` },
      { field: 'tokenId', message: `token ${TOKEN} has no ft_metadata` },
      { field: 'tokenId', message: `token ${TOKEN} has no storage_balance_bounds (NEP-145), so the vault cannot register payees` },
    ]);
    const chain = world();
    const taken = await refused(body(), { ...chain, account: async (id) => (id === `shop.${OWNER}` ? acct(1n) : chain.account(id)) });
    expect(taken).toEqual({ ok: false, code: 'VAULT_EXISTS', vaultId: `shop.${OWNER}`, problems: [{ field: 'name', message: `shop.${OWNER} already exists` }] });
    const poor = await refused(body(), { ...chain, account: async (id) => (id === OWNER ? acct(NEAR) : chain.account(id)) });
    expect(poor.problems[0].field).toBe('fundNear');
    expect(poor.problems[0].message).toStartWith(`owner ${OWNER} can spend`);
    const lowDeposit = await refused(body({ policy: { storage_deposit: '1' } }));
    expect(lowDeposit.problems).toEqual([{ field: 'policy.storage_deposit', message: "policy.storage_deposit must be at least the token's storage_balance_bounds.min (1250000000000000000000 yocto, about 0.0013 NEAR)" }]);
  });

  test('mainnet is refused unless enabled', async () => {
    const r = await refused(body(), world(), { ...CFG, network: 'mainnet' });
    expect(r.code).toBe('VAULT_PLAN_DISABLED');
  });

});

// Audit findings NF-02 and NF-06 (plan floor): caps follow the token, payee_delay cannot be set to frame the agent.
describe('NF-02 default caps follow the token decimals', () => {
  const withDecimals = (decimals: number) => {
    const chain = world();
    return { ...chain, view: async <T>(c: string, m: string) => (m === 'ft_metadata' ? ({ symbol: 'TOK', decimals } as T) : chain.view<T>(c, m)) };
  };
  const plan = async (decimals: number, policy?: Record<string, unknown>) => {
    const r = await buildVaultPlan(body(policy ? { policy } : {}), CFG, withDecimals(decimals));
    if (!r.ok) throw new Error(r.problems.map((p) => p.message).join('; '));
    return r.plan;
  };

  test('scaleDefaultCap is exact in both directions and refuses what u128 or integers cannot hold', () => {
    expect(scaleDefaultCap('5000000', 6)).toBe('5000000');
    expect(scaleDefaultCap('5000000', 2)).toBe('500');
    expect(scaleDefaultCap('2000000', 0)).toBe('2');
    expect(scaleDefaultCap('5000000', 18)).toBe('5000000000000000000');
    expect(scaleDefaultCap('5000001', 0)).toBeNull();
    expect(scaleDefaultCap('5000000', 38)).toBeNull(); // 5e38 is above u128
  });

  test('the PoC token with 2 decimals gets 5 and 2 tokens, not 50,000 and 20,000', async () => {
    const p = await plan(2);
    expect(p.init.policy.daily_cap).toBe('500');
    expect(p.init.policy.max_per_payment).toBe('200');
    expect(p.caps).toEqual({ dailyCap: '500', maxPerPayment: '200', scaled: ['daily_cap', 'max_per_payment'] });
    expect(p.warnings).toEqual([]);
    expect((p.transactions[0].actions[3] as { params: { args: { policy: { daily_cap: string } } } }).params.args.policy.daily_cap).toBe('500');
  });

  test('0 and 24 decimals scale too; tUSDC is unchanged', async () => {
    expect((await plan(0)).caps).toMatchObject({ dailyCap: '5', maxPerPayment: '2' });
    expect((await plan(24)).caps).toMatchObject({ dailyCap: '5000000000000000000000000', maxPerPayment: '2000000000000000000000000' });
    expect((await plan(6)).caps).toEqual({ dailyCap: '5000000', maxPerPayment: '2000000', scaled: ['daily_cap', 'max_per_payment'] });
  });

  test('a default that cannot be scaled is refused without a field', async () => {
    const r = await refused(body(), withDecimals(38));
    expect(r.code).toBe('VAULT_PLAN_REFUSED');
    expect(r.problems[0].field).toBeUndefined();
    expect(r.problems[0].message).toContain('set policy.daily_cap and policy.max_per_payment');
  });

  test('caps the owner set are kept as given and warned about; the other default is scaled and compared after scaling', async () => {
    const p = await plan(2, { daily_cap: '1000' });
    expect(p.caps).toEqual({ dailyCap: '1000', maxPerPayment: '200', scaled: ['max_per_payment'] });
    expect(p.warnings[0]).toContain('2 decimals');
    const low = await refused(body({ policy: { daily_cap: '100' } }), withDecimals(2));
    expect(low.problems).toEqual([{ field: 'policy.max_per_payment', message: 'max_per_payment above daily_cap' }]);
    // the unscaled default (2000000) must not trip the comparison before scaling
    expect((await plan(2, { daily_cap: '300' })).caps.maxPerPayment).toBe('200');
  });

  test('payee_delay below 1 hour is a field error', async () => {
    for (const payee_delay of ['0', '3599999999999']) {
      const r = await refused(body({ policy: { payee_delay } }));
      expect(r.code).toBe('VALIDATION_ERROR');
      expect(r.problems.map((p) => p.field)).toEqual(['policy.payee_delay']);
    }
    expect((await plan(6, { payee_delay: '3600000000000' })).init.policy.payee_delay).toBe('3600000000000');
  });
});

describe('GET /public/vault view', () => {
  const VAULT = `shop.${OWNER}`;
  const views = { [`${VAULT}.get_status`]: { mode: 'Unarmed', version: '2.3.0' }, [`${VAULT}.get_scorecard`]: { score_bps: null }, [`${VAULT}.get_policy`]: { ...DEFAULT_POLICY } };

  test('a missing account, other global code or classic code with the same hash is not a vault', async () => {
    expect(await readVault(fakeChain({ views }), VAULT, HASH)).toEqual({ kind: 'missing' });
    expect(await readVault(fakeChain({ accounts: { [VAULT]: acct(NEAR, { globalCodeHash: 'otherhash' }) }, views }), VAULT, HASH)).toEqual({ kind: 'foreign', codeHash: 'otherhash' });
    expect(await readVault(fakeChain({ accounts: { [VAULT]: acct(NEAR, { codeHash: HASH }) }, views }), VAULT, HASH)).toEqual({ kind: 'foreign', codeHash: HASH });
    expect((await readVault(fakeChain({ accounts: { [VAULT]: acct(NEAR, { globalCodeHash: HASH }) }, views }), VAULT, '')).kind).toBe('foreign');
  });

  test('matching code but never initialized is not a vault', async () => {
    expect(await readVault(fakeChain({ accounts: { [VAULT]: acct(NEAR, { globalCodeHash: HASH }) } }), VAULT, HASH)).toEqual({ kind: 'foreign', codeHash: HASH });
  });

  test('a matching vault returns its views and a key summary', async () => {
    const keys = [
      { public_key: 'ed25519:A', access_key: { permission: { GasKeyFunctionCall: { receiver_id: VAULT, method_names: ['pay', 'decline', 'ack'], balance: '1', num_nonces: 4 } } } },
      { public_key: 'ed25519:B', access_key: { permission: 'FullAccess' } },
    ];
    const r = await readVault(fakeChain({ accounts: { [VAULT]: acct(NEAR, { globalCodeHash: HASH }) }, views, keys: { [VAULT]: keys } }), VAULT, HASH);
    if (r.kind !== 'vault') throw new Error(r.kind);
    const v = r.vault;
    expect(v).toMatchObject({ vaultId: VAULT, codeHash: HASH, status: { version: '2.3.0' }, scorecard: { score_bps: null }, policy: { ...DEFAULT_POLICY } });
    expect(v.keys).toEqual(keys);
    expect(v.keySummary).toEqual({
      count: 2,
      fullAccess: 1,
      nonAgentKeys: 1,
      truncated: false,
      items: [
        { publicKey: 'ed25519:A', kind: 'function_call', variant: 'GasKeyFunctionCall', receiverId: VAULT, methodNames: ['pay', 'decline', 'ack'] },
        { publicKey: 'ed25519:B', kind: 'full', variant: 'FullAccess' },
      ],
    });
  });
});

// The routes through the real app and near-api-js, against a local JSON-RPC stand-in. No database is reachable.
// Chrome E2E 2026-11-12: every problem comes back in one answer, with readable NEAR amounts.
describe('plan errors are aggregated', () => {
  const POOR = 'ss-vendor-e9c3db.testnet';
  const poorChain = () => {
    const chain = world();
    return { ...chain, account: async (id: string) => (id === POOR ? acct(495_312_345_678_901_234_567_890n) : chain.account(id)) };
  };

  test('the E2E repro: a poor owner and max_per_payment above the scaled daily cap are reported together', async () => {
    const r = await refused(body({ ownerId: POOR, policy: { max_per_payment: '9000000' } }), poorChain());
    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.problems).toEqual([
      { field: 'fundNear', message: `owner ${POOR} can spend 0.4943 NEAR, needs 1.5013 NEAR plus about 0.05 NEAR in fees` }, // 0.4953 less 100 B of storage
      { field: 'policy.max_per_payment', message: 'max_per_payment above daily_cap' },
    ]);
  });

  test('pure and chain problems arrive in one answer, each once', async () => {
    const r = await refused(body({ vendorId: OWNER, fundNear: '0.5', policy: { payee_delay: '0', min_answer: '1' } }), fakeChain({ published: [] }));
    expect(r.problems.map((p) => p.field)).toEqual(['vendorId', 'policy.min_answer', 'policy.payee_delay', 'fundNear', 'ownerId', 'vendorId', undefined, 'tokenId', 'tokenId']);
    expect(new Set(r.problems.map((p) => `${p.field}|${p.message}`)).size).toBe(r.problems.length);
    expect(r.code).toBe('VAULT_PLAN_REFUSED'); // the unpublished code has no field
  });

  test('an existing vault still answers 409, with every other problem listed', async () => {
    const chain = poorChain();
    const r = await refused(body({ ownerId: POOR, policy: { payee_delay: '0' } }), { ...chain, account: async (id) => (id === `shop.${POOR}` ? acct(1n) : chain.account(id)) });
    expect(r.code).toBe('VAULT_EXISTS');
    expect(r.vaultId).toBe(`shop.${POOR}`);
    expect(r.problems.map((p) => p.field)).toEqual(['policy.payee_delay', 'name', 'fundNear']);
  });

  test('no message carries a NEAR amount with more than 4 decimals', async () => {
    const r = await refused(body({ ownerId: POOR, fundNear: '0.123456789', policy: { storage_deposit: '1' } }), poorChain());
    for (const p of r.problems) expect(p.message).not.toMatch(/\d\.\d{5,} NEAR/);
    expect(r.problems.find((p) => p.field === 'policy.storage_deposit')?.message).toContain('about 0.0013 NEAR');
  });

  test('an invalid vault id or a missing token skips only the reads that need it', async () => {
    const chain = world();
    await refused(body({ name: 'x'.repeat(60) }), chain);
    expect(chain.calls).not.toContain(`account:${'x'.repeat(60)}.${OWNER}`);
    expect(chain.calls).toContain(`account:${OWNER}`);
    const noToken = fakeChain();
    const r = await refused(body(), noToken, { ...CFG, defaultTokenId: '' });
    expect(r.problems[0]).toEqual({ field: 'tokenId', message: 'tokenId is required: no default token on this network' });
    expect(noToken.calls.some((c) => c.startsWith('view:'))).toBe(false);
  });
});

describe('NF-03 no key hides past the cut', () => {
  const VAULT = `shop.${OWNER}`;
  const views = { [`${VAULT}.get_status`]: { mode: 'Armed' }, [`${VAULT}.get_scorecard`]: {}, [`${VAULT}.get_policy`]: {} };
  const fc = (i: number) => ({ public_key: `ed25519:K${i}`, access_key: { nonce: 0, permission: { FunctionCall: { receiver_id: VAULT, method_names: ['pay', 'decline', 'ack'], allowance: null } } } });
  const read = async (keys: ReturnType<typeof fc>[] | unknown[]) => {
    const r = await readVault(fakeChain({ accounts: { [VAULT]: acct(NEAR, { globalCodeHash: HASH }) }, views, keys: { [VAULT]: keys as never } }), VAULT, HASH);
    if (r.kind !== 'vault') throw new Error(r.kind);
    return r.vault;
  };

  test('the audit PoC: a full-access key 21st is shown and counted', async () => {
    const keys = [...Array.from({ length: 20 }, (_, i) => fc(i)), { public_key: 'secp256k1:Z', access_key: { nonce: 0, permission: 'FullAccess' } }];
    const v = await read(keys);
    expect(v.keys).toHaveLength(21);
    expect(v.keySummary).toMatchObject({ count: 21, fullAccess: 1, nonAgentKeys: 1, truncated: false });
  });

  test('past 100 keys the list is cut and flagged, but counts cover every key', async () => {
    const keys = [...Array.from({ length: 120 }, (_, i) => fc(i)), { public_key: 'secp256k1:Z', access_key: { nonce: 0, permission: { GasKeyFullAccess: { balance: '1', num_nonces: 1 } } } }];
    const v = await read(keys);
    expect(v.keys).toHaveLength(100);
    expect(v.keySummary.items).toHaveLength(100);
    expect(v.keySummary).toMatchObject({ count: 121, fullAccess: 1, nonAgentKeys: 1, truncated: true });
  });
});

describe('NF-04 route-owned bounded cache', () => {
  test('a full cache evicts its least recently used entry only', async () => {
    let t = 0;
    const lru = createLru<string>(2, 1_000, () => t);
    let loads = 0;
    const load = (v: string) => async () => (loads++, v);
    await lru.get('a', load('A'));
    await lru.get('b', load('B'));
    await lru.get('a', load('A2')); // touch a
    await lru.get('c', load('C')); // evicts b
    expect(lru.size).toBe(2);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
    expect(await lru.get('a', load('A3'))).toBe('A');
    expect(loads).toBe(3);
    t = 1_000;
    expect(lru.has('a')).toBe(false);
  });

  test('failures are not cached', async () => {
    const lru = createLru<string>(4, 60_000);
    await expect(lru.get('x', async () => Promise.reject(new Error('rpc down')))).rejects.toThrow('rpc down');
    expect(lru.has('x')).toBe(false);
    expect(await lru.get('x', async () => 'ok')).toBe('ok');
  });

  test('the vault routes never use the shared cache for ids, nor write ErrorLog rows', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/routes/vaultRoutes.ts'), 'utf8');
    expect(src).not.toMatch(/cached\(`vault-(view|created)/);
    expect(src).not.toContain('handleError(');
  });
});

describe('vault routes over HTTP', () => {
  const VAULT = 'good.acme.testnet';
  const OTHER = 'other.acme.testnet';
  const KEYS = [{ public_key: 'ed25519:HYnC71oRwPTVR2h2FBBphebpA4RKube17Qq4KKDrAyUh', access_key: { nonce: 0, permission: { GasKeyFunctionCall: { allowance: null, balance: '1', method_names: ['pay', 'decline', 'ack'], num_nonces: 4, receiver_id: 'good.acme.testnet' } } } }];
  let server: ReturnType<typeof Bun.serve>;
  const result = (v: unknown) => ({ result: [...new TextEncoder().encode(JSON.stringify(v))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' });
  const viewAccount = (globalHash: string | null) => ({ amount: '2000000000000000000000000', locked: '0', code_hash: '11111111111111111111111111111111', global_contract_hash: globalHash, storage_usage: 600, storage_paid_at: 0, block_height: 1, block_hash: '11111111111111111111111111111111' });
  const unknownAccount = (id: string) => ({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: id, block_hash: '11111111111111111111111111111111', block_height: 1 } }, code: -32000, message: 'Server error', data: `account ${id} does not exist while viewing` });

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        // FastNEAR tx API: the vault's creation tx
        if (new URL(req.url).pathname === '/v0/account') {
          const { account_id } = (await req.json()) as { account_id: string };
          return Response.json({ account_txs: account_id === VAULT ? [{ transaction_hash: 'CreatedTx1111' }] : [] });
        }
        const { id, params: q } = (await req.json()) as { id: unknown; params: Record<string, string> };
        const ok = (r: unknown) => Response.json({ jsonrpc: '2.0', id, result: r });
        if (q.request_type === 'view_account') {
          if (q.account_id === VAULT) return ok(viewAccount(HASH));
          if (q.account_id === OTHER) return ok(viewAccount('9'.repeat(44)));
          return Response.json({ jsonrpc: '2.0', id, error: unknownAccount(q.account_id) });
        }
        if (q.request_type === 'view_access_key_list') return ok({ keys: KEYS, block_height: 1, block_hash: '11111111111111111111111111111111' });
        if (q.request_type === 'view_global_contract_code') return ok({ code_base64: '', hash: HASH, block_height: 1, block_hash: '11111111111111111111111111111111' });
        if (q.request_type === 'call_function') return ok(result({ method: q.method_name }));
        return Response.json({ jsonrpc: '2.0', id, error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR', info: { error_message: 'unsupported' } }, code: -32700, message: 'Parse error' } });
      },
    });
  });
  afterAll(() => server.stop(true));

  // own process: main-config reads env at import time and exits without it
  const run = async (reqs: { method: 'GET' | 'POST'; url: string; payload?: unknown; remoteAddress?: string }[]) => {
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
        INBOX_TOKEN_HASH: '0'.repeat(64),
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: `http://127.0.0.1:${server.port}`,
        NEAR_RPC_URLS: `http://127.0.0.1:${server.port}`, // Bun loads backend/.env from cwd; keep failover reads local too
        NEAR_TX_API_URL: `http://127.0.0.1:${server.port}`,
      },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7)) as { status: number; body: { success: boolean; error: Record<string, unknown> | null; data: Record<string, unknown> | null } }[];
  };

  test('vault view: 200 with raw keys and createdTx, 422 with the account code hash, 404 when missing; plan errors carry fields', async () => {
    const [good, other, missing, malformed, badPlan, sameParty, exists] = await run([
      { method: 'GET', url: `/public/vault/${VAULT}` },
      { method: 'GET', url: `/public/vault/${OTHER}` },
      { method: 'GET', url: '/public/vault/nobody.testnet' },
      { method: 'GET', url: '/public/vault/Not..An..Id' },
      { method: 'POST', url: '/public/vault-plan', payload: { ownerId: OWNER, name: 'Bad.Name', vendorId: VENDOR, fundNear: '1.5', extra: 1 } },
      { method: 'POST', url: '/public/vault-plan', payload: { ownerId: OWNER, name: 'shop', vendorId: OWNER, fundNear: '1.5' } },
      { method: 'POST', url: '/public/vault-plan', payload: { ownerId: 'acme.testnet', name: 'good', vendorId: VENDOR, fundNear: '1.5' } },
    ]);
    expect(good.status).toBe(200);
    expect(good.body.data).toMatchObject({ vaultId: VAULT, codeHash: HASH, keys: KEYS, keySummary: { count: 1 }, status: { method: 'get_status' }, createdTx: 'CreatedTx1111', registered: null });
    expect(other.status).toBe(422);
    expect(other.body.error).toMatchObject({ code: 'NOT_A_VAULT', codeHash: '9'.repeat(44) });
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(400);
    expect(badPlan.status).toBe(400);
    expect(badPlan.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid input: name, extra' });
    expect((badPlan.body.error!.fields as { field: string }[]).map((f) => f.field)).toEqual(['name', 'extra']);
    expect(sameParty.status).toBe(400);
    expect(sameParty.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(String(sameParty.body.error!.message)).toStartWith('owner and vendor must differ; ');
    expect(sameParty.body.error!.fields).toContainEqual({ field: 'vendorId', message: 'owner and vendor must differ' });
    expect(sameParty.body.error!.fields).toContainEqual({ field: 'ownerId', message: 'owner acme.testnet does not exist on testnet' });
    expect(exists.status).toBe(409);
    expect(exists.body.error).toMatchObject({ code: 'VAULT_EXISTS', vaultId: VAULT });
    expect(exists.body.error!.fields).toContainEqual({ field: 'name', message: `${VAULT} already exists` });
  }, 30_000);

  test('NF-04: uncached lookups share a 60 a minute budget across IPs; cached ids still answer', async () => {
    const ids = Array.from({ length: 61 }, (_, i) => ({ method: 'GET' as const, url: `/public/vault/n${i}.testnet`, remoteAddress: `10.0.${i}.1` }));
    const res = await run([...ids, { method: 'GET', url: '/public/vault/n0.testnet', remoteAddress: '10.9.9.9' }]);
    expect(res.slice(0, 60).every((r) => r.status === 404)).toBe(true);
    expect(res[60].status).toBe(503);
    expect(res[60].body.error).toMatchObject({ code: 'VAULT_READS_BUSY' });
    expect(res[61].status).toBe(404);
  }, 30_000);
});
