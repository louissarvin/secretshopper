import { z } from 'zod';
import { isValidAccountId } from '../../utils/ids.ts';
import { checkPolicy, DEFAULT_POLICY, DEFAULT_POLICY_DECIMALS, MIN_PLAN_PAYEE_DELAY_NS, minFunding, YOCTO_PER_NEAR, type Policy, type VaultInit } from './policy.ts';

// Self-serve vault plan: the unsigned transactions an owner signs in a wallet to create a vault from a published
// global contract. Pure: chain reads come in through `VaultChain`, so the route, tests and scripts share it.

export type Network = 'testnet' | 'mainnet';

export interface AccountState {
  amount: bigint;
  locked: bigint;
  storageUsage: number;
  codeHash: string;
  globalCodeHash: string | null;
}

export interface AccessKeyEntry {
  public_key: string;
  access_key: { nonce?: number; permission: unknown };
}

/** Read-only chain access. `account` and `view` return null when the account, its code or the method is missing. */
export interface VaultChain {
  account(accountId: string): Promise<AccountState | null>;
  globalCodePublished(codeHash: string): Promise<boolean>;
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T | null>;
  accessKeys(accountId: string): Promise<AccessKeyEntry[]>;
}

export interface PlanConfig {
  network: Network;
  codeHash: string; // bs58 of the published global contract, empty when not configured
  defaultTokenId: string;
  allowMainnet: boolean;
}

// FunctionCall gas as create-vault.ts sends it: `new` with 50 Tgas (shop3, shop4 created with it), storage_deposit 30 Tgas.
export const INIT_GAS = '50000000000000';
export const STORAGE_DEPOSIT_GAS = '30000000000000';
const FEE_MARGIN = YOCTO_PER_NEAR / 20n; // 0.05 NEAR for both transactions' gas, as create-vault.ts checks
const BYTE = 10n ** 19n;

/** ConnectorAction JSON of @hot-labs/near-connect (amounts and gas as decimal strings). */
export type ConnectorAction =
  | { type: 'CreateAccount' }
  | { type: 'Transfer'; params: { deposit: string } }
  | { type: 'UseGlobalContract'; params: { contractIdentifier: { codeHash: string } } }
  | { type: 'FunctionCall'; params: { methodName: string; args: object; gas: string; deposit: string } };

export interface PlannedTx {
  signerId: string;
  receiverId: string;
  actions: ConnectorAction[];
}

export interface VaultPlan {
  network: Network;
  signerId: string; // NEAR Connect signs with the connected account; every tx below is from it
  vaultId: string;
  codeHash: string;
  token: { id: string; symbol: string; decimals: number };
  caps: { dailyCap: string; maxPerPayment: string; scaled: CapField[] }; // token base units; `scaled` lists defaults scaled to the token
  fundYocto: string;
  minFundingYocto: string;
  storageDepositYocto: string;
  totalYocto: string; // every deposit across both transactions
  init: VaultInit;
  transactions: PlannedTx[];
  cli: string[];
  next: string[];
  warnings: string[];
}

type CapField = 'daily_cap' | 'max_per_payment';
const CAP_FIELDS: CapField[] = ['daily_cap', 'max_per_payment'];
const U128_LIMIT = 1n << 128n;

/** NF-02: a default cap (6-decimal units) in base units of a token with `decimals`; null unless exact, positive and within u128. */
export const scaleDefaultCap = (cap: string, decimals: number): string | null => {
  const v = BigInt(cap);
  const shift = 10n ** BigInt(Math.abs(decimals - DEFAULT_POLICY_DECIMALS));
  const out = decimals >= DEFAULT_POLICY_DECIMALS ? v * shift : v / shift;
  if (decimals < DEFAULT_POLICY_DECIMALS && out * shift !== v) return null;
  return out > 0n && out < U128_LIMIT ? out.toString() : null;
};

/** A reason to refuse; `field` names the request field it belongs to (`policy.<key>` for policy fields). */
export interface Problem {
  field?: string;
  message: string;
}

export type PlanResult =
  | { ok: true; plan: VaultPlan }
  | { ok: false; code: 'VALIDATION_ERROR' | 'VAULT_EXISTS' | 'VAULT_PLAN_DISABLED' | 'VAULT_PLAN_REFUSED'; problems: Problem[]; vaultId?: string; malformed?: true };

const accountId = z.string().max(64).refine(isValidAccountId, 'invalid NEAR account id');
// one refine: zod 4 still runs later checks after a failed regex, and BigInt throws on non-digits
const uint = (bits: bigint) => z.string().refine((v) => /^(0|[1-9]\d{0,38})$/.test(v) && BigInt(v) < 1n << bits, `decimal integer below 2^${bits}`);
const u128 = uint(128n);
const u64 = uint(64n);
const u32 = z.number().int().min(0).max(0xffffffff);

export const policyOverrideSchema = z
  .object({
    daily_cap: u128,
    max_per_payment: u128,
    max_new_payees_per_day: u32,
    max_payments_per_day: u32,
    max_decisions_per_day: u32,
    batch_size: u32,
    batch_interval: u64,
    test_ttl: u64,
    reveal_grace: u64,
    rearm_cooldown: u64,
    payee_delay: u64,
    limits_delay: u64,
    key_allowance: u128,
    key_nonces: u32,
    min_answer: u64,
    storage_deposit: u128,
    min_near_float: u128,
  })
  .partial()
  .strict();

// One account-id part: the vault is `${name}.${ownerId}`, a direct sub-account the owner can create.
export const VAULT_NAME_RE = /^([a-z\d]+[-_])*[a-z\d]+$/;

export const vaultPlanBody = z
  .object({
    ownerId: accountId,
    name: z.string().min(1).max(63).regex(VAULT_NAME_RE, 'lowercase letters, digits, single - or _ inside'),
    vendorId: accountId,
    tokenId: accountId.optional(),
    policy: policyOverrideSchema.optional(),
    fundNear: z.string().regex(/^(0|[1-9]\d{0,8})(\.\d{1,24})?$/, 'decimal NEAR, up to 24 decimals'),
  })
  .strict();
export type VaultPlanBody = z.infer<typeof vaultPlanBody>;

/** Decimal NEAR string (validated by vaultPlanBody) to yocto, exactly. */
export const parseNear = (s: string): bigint => {
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, '0'));
};

const NEAR_DIGITS = 4;

/** Yocto to NEAR with at most 4 decimals for messages: amounts owed round up, balances held round down. */
export const formatNear = (yocto: bigint, round: 'ceil' | 'floor' = 'ceil'): string => {
  const unit = YOCTO_PER_NEAR / 10n ** BigInt(NEAR_DIGITS);
  const units = yocto / unit + (round === 'ceil' && yocto % unit ? 1n : 0n);
  const whole = units / 10n ** BigInt(NEAR_DIGITS);
  const frac = (units % 10n ** BigInt(NEAR_DIGITS)).toString().padStart(NEAR_DIGITS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** NEAR an account can spend: its balance minus what its storage needs beyond the locked stake. */
const spendable = (a: AccountState): bigint => {
  const storage = BigInt(a.storageUsage) * BYTE;
  const free = a.amount + a.locked - storage;
  return free < a.amount ? (free > 0n ? free : 0n) : a.amount;
};

const ftMetadataSchema = z.object({ symbol: z.string().min(1).max(32), decimals: z.number().int().min(0).max(38) });
const boundsSchema = z.object({ min: u128 });

/** Ordered steps after both transactions land. */
export const nextSteps = (o: { vaultId: string; ownerId: string; vendorId: string; tokenId: string; symbol: string }): string[] => [
  `Check the vault: GET /public/vault/${o.vaultId} shows its code hash, keys, status and policy (no access keys is expected).`,
  `Add the vendor's payout accounts: ${o.ownerId} calls add_payee { account_id, label } on ${o.vaultId} with 1 yoctoNEAR attached; a payee becomes active after policy.payee_delay.`,
  `Propose the agent key: ${o.ownerId} calls propose_key { public_key } on ${o.vaultId} with 1 yoctoNEAR (the agent's ed25519 public key).`,
  `Arm the agent: the vendor ${o.vendorId} calls accept_key { public_key } on ${o.vaultId} with 1 yoctoNEAR and 30 Tgas (the vendor console sends exactly this call). A gas key is funded from the vault's NEAR.`,
  `If the second transaction (token registration) did not go through, resend it alone: it is cli[1], or the second entry of transactions.`,
  `Fund the vault with ${o.symbol}: ft_transfer on ${o.tokenId} to ${o.vaultId} (1 yoctoNEAR attached); the vault is registered on the token by the second transaction.`,
  `Run your own tester and agent against ${o.vaultId}: add a function-call key on ${o.ownerId} for ${o.vaultId} with methods commit_batch, reveal, release, prove_delivery for the tester, set SHOP_CONTRACT_ID=${o.vaultId} in the API, tester and agent config, then register the company with POST /company.`,
];

const cliFor = (o: { network: Network; ownerId: string; vaultId: string; codeHash: string; fund: bigint; init: VaultInit; tokenId: string; storageDeposit: bigint }): string[] => [
  [
    `near transaction construct-transaction ${o.ownerId} receiver-id ${o.vaultId}`,
    'add-action create-account',
    `add-action transfer ${shq(`${o.fund} yoctonear`)}`,
    `add-action use-global-contract use-global-hash ${o.codeHash}`,
    `with-init-call new json-args ${shq(JSON.stringify(o.init))} prepaid-gas '50 Tgas' attached-deposit '0 NEAR'`,
    `skip network-config ${o.network} sign-with-legacy-keychain send`,
  ].join(' '),
  [
    `near contract call-function as-transaction ${o.tokenId} storage_deposit`,
    `json-args ${shq(JSON.stringify({ account_id: o.vaultId, registration_only: true }))}`,
    `prepaid-gas '30 Tgas' attached-deposit ${shq(`${o.storageDeposit} yoctonear`)}`,
    `sign-as ${o.ownerId} network-config ${o.network} sign-with-legacy-keychain send`,
  ].join(' '),
];

/** The two transactions, in order: create + fund + attach code + `new` on the vault, then the vault's token registration. */
export const planTransactions = (o: { ownerId: string; vaultId: string; codeHash: string; fund: bigint; init: VaultInit; tokenId: string; storageDeposit: bigint }): PlannedTx[] => [
  {
    signerId: o.ownerId,
    receiverId: o.vaultId,
    actions: [
      { type: 'CreateAccount' },
      { type: 'Transfer', params: { deposit: o.fund.toString() } },
      { type: 'UseGlobalContract', params: { contractIdentifier: { codeHash: o.codeHash } } },
      // `new` passes its access check because the predecessor is the vault's parent and signed the tx itself (V21-03)
      { type: 'FunctionCall', params: { methodName: 'new', args: o.init, gas: INIT_GAS, deposit: '0' } },
    ],
  },
  {
    signerId: o.ownerId,
    receiverId: o.tokenId,
    actions: [
      {
        type: 'FunctionCall',
        params: { methodName: 'storage_deposit', args: { account_id: o.vaultId, registration_only: true }, gas: STORAGE_DEPOSIT_GAS, deposit: o.storageDeposit.toString() },
      },
    ],
  },
];

// Unknown keys arrive as one issue listing them; split so each gets its own field.
const zodProblems = (issues: z.core.$ZodIssue[]): Problem[] =>
  issues.flatMap((i) =>
    i.code === 'unrecognized_keys'
      ? i.keys.map((k) => ({ field: [...i.path, k].join('.'), message: 'unknown field' }))
      : [{ field: i.path.join('.') || '(root)', message: i.message }]
  );

/** An existing vault wins (409); field-only problems are a validation error; anything else is a refusal. */
const refusal = (problems: Problem[], existing?: string): PlanResult => {
  if (existing) return { ok: false, code: 'VAULT_EXISTS', problems, vaultId: existing };
  return { ok: false, code: problems.every((p) => p.field) ? 'VALIDATION_ERROR' : 'VAULT_PLAN_REFUSED', problems };
};

/** Validates the request against the chain and returns the plan, or every reason to refuse. Never signs. */
export const buildVaultPlan = async (raw: unknown, cfg: PlanConfig, chain: VaultChain): Promise<PlanResult> => {
  const parsed = vaultPlanBody.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_ERROR', problems: zodProblems(parsed.error.issues), malformed: true };
  if (cfg.network === 'mainnet' && !cfg.allowMainnet) return { ok: false, code: 'VAULT_PLAN_DISABLED', problems: [{ message: 'self-serve vault plans are disabled on mainnet' }] };
  if (!cfg.codeHash) return { ok: false, code: 'VAULT_PLAN_DISABLED', problems: [{ message: `no vault code hash configured for ${cfg.network}` }] };

  const body = parsed.data;
  const tokenId = body.tokenId ?? cfg.defaultTokenId;
  const vaultId = `${body.name}.${body.ownerId}`;
  const policy: Policy = { ...DEFAULT_POLICY, ...body.policy };
  const fund = parseNear(body.fundNear);
  const problems: Problem[] = [];
  const warnings: string[] = [];
  const add = (field: string | undefined, message: string) => {
    if (!problems.some((p) => p.field === field && p.message === message)) problems.push(field ? { field, message } : { message });
  };
  const validVaultId = isValidAccountId(vaultId);

  // Every check runs and every problem is returned together; chain reads are skipped only where their input is unusable.
  if (!tokenId) add('tokenId', 'tokenId is required: no default token on this network');
  if (!validVaultId) add('name', `vault id ${vaultId} is not a valid NEAR account id (64 characters at most)`);
  if (body.ownerId === body.vendorId) add('vendorId', 'owner and vendor must differ');
  const defaulted = CAP_FIELDS.filter((k) => body.policy?.[k] === undefined);
  const policyProblems = (p: Policy) => checkPolicy(p).forEach((m) => add(`policy.${/^[a-z_]+/.exec(m)![0]}`, m));
  // the cap comparison waits for the defaults to be scaled to the token
  policyProblems(defaulted.length ? { ...policy, max_per_payment: '0' } : policy);
  if (BigInt(policy.payee_delay) < MIN_PLAN_PAYEE_DELAY_NS)
    add('policy.payee_delay', `payee_delay must be at least 1 h (${MIN_PLAN_PAYEE_DELAY_NS} ns), so the owner cannot delist a payee and frame the agent in one block`);
  const need = minFunding({ kind: 'global', codeHash: new Uint8Array(32) }, policy);
  if (fund < need) add('fundNear', `fund at least ${formatNear(need)} NEAR (storage, reveal float, first gas-key arming, its re-key reserve and headroom)`);

  const [owner, vendor, vault, published, meta, bounds] = await Promise.all([
    chain.account(body.ownerId),
    chain.account(body.vendorId),
    validVaultId ? chain.account(vaultId) : null,
    chain.globalCodePublished(cfg.codeHash),
    tokenId ? chain.view<unknown>(tokenId, 'ft_metadata') : null,
    tokenId ? chain.view<unknown>(tokenId, 'storage_balance_bounds') : null,
  ]);
  if (!owner) add('ownerId', `owner ${body.ownerId} does not exist on ${cfg.network}`);
  if (!vendor) add('vendorId', `vendor ${body.vendorId} does not exist on ${cfg.network}`);
  if (vault) add('name', `${vaultId} already exists`);
  if (!published) add(undefined, `no global contract with hash ${cfg.codeHash} on ${cfg.network}`);
  const token = ftMetadataSchema.safeParse(meta);
  if (tokenId && !token.success) add('tokenId', `token ${tokenId} has no ft_metadata`);
  const min = boundsSchema.safeParse(bounds);
  if (tokenId && !min.success) add('tokenId', `token ${tokenId} has no storage_balance_bounds (NEP-145), so the vault cannot register payees`);
  else if (min.success && BigInt(policy.storage_deposit) < BigInt(min.data.min))
    add('policy.storage_deposit', `policy.storage_deposit must be at least the token's storage_balance_bounds.min (${min.data.min} yocto, about ${formatNear(BigInt(min.data.min))} NEAR)`);
  const storageDeposit = BigInt(policy.storage_deposit);
  if (owner && spendable(owner) < fund + storageDeposit + FEE_MARGIN)
    add('fundNear', `owner ${body.ownerId} can spend ${formatNear(spendable(owner), 'floor')} NEAR, needs ${formatNear(fund + storageDeposit)} NEAR plus about 0.05 NEAR in fees`);

  // caps the request left out are scaled to the token, then compared; without token metadata only given caps were checked
  if (token.success) {
    for (const k of defaulted) {
      const scaled = scaleDefaultCap(DEFAULT_POLICY[k], token.data.decimals);
      if (scaled === null) add(undefined, `the default ${k} cannot be expressed exactly in ${token.data.symbol} base units (${token.data.decimals} decimals); set policy.daily_cap and policy.max_per_payment`);
      else policy[k] = scaled;
    }
    if (defaulted.length) policyProblems(policy);
  }
  if (problems.length) return refusal(problems, vault ? vaultId : undefined);

  const { symbol, decimals } = token.data!;
  if (defaulted.length < CAP_FIELDS.length && decimals !== DEFAULT_POLICY_DECIMALS)
    warnings.push(`policy caps you set are ${symbol} base units with ${decimals} decimals: daily_cap ${policy.daily_cap}, max_per_payment ${policy.max_per_payment}`);

  const init: VaultInit = { owner_id: body.ownerId, vendor_id: body.vendorId, token_id: tokenId, intents_id: null, policy };
  const tx = { ownerId: body.ownerId, vaultId, codeHash: cfg.codeHash, fund, init, tokenId, storageDeposit };
  return {
    ok: true,
    plan: {
      network: cfg.network,
      signerId: body.ownerId,
      vaultId,
      codeHash: cfg.codeHash,
      token: { id: tokenId, symbol, decimals },
      caps: { dailyCap: policy.daily_cap, maxPerPayment: policy.max_per_payment, scaled: defaulted },
      fundYocto: fund.toString(),
      minFundingYocto: need.toString(),
      storageDepositYocto: storageDeposit.toString(),
      totalYocto: (fund + storageDeposit).toString(),
      init,
      transactions: planTransactions(tx),
      cli: cliFor({ ...tx, network: cfg.network }),
      next: nextSteps({ vaultId, ownerId: body.ownerId, vendorId: body.vendorId, tokenId, symbol }),
      warnings,
    },
  };
};
