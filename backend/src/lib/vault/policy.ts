import { MIN_REVEAL_GRACE_MS } from '../proof/tlock.ts';
import { isValidAccountId } from '../../utils/ids.ts';

// Vault policy rules shared by scripts/create-vault.ts and the self-serve plan route. Pure: no config, DB or HTTP.

/** `new` args policy, as contracts/shop/src/lib.rs `Policy` serializes it. */
export interface Policy {
  daily_cap: string;
  max_per_payment: string;
  max_new_payees_per_day: number;
  max_payments_per_day: number;
  max_decisions_per_day: number;
  batch_size: number;
  batch_interval: string;
  test_ttl: string;
  reveal_grace: string;
  rearm_cooldown: string;
  payee_delay: string;
  limits_delay: string;
  key_allowance: string;
  key_nonces?: number; // 0 or absent: classic key with key_allowance as allowance; 1 to 64: NEP-611 gas key funded with key_allowance (V23-09)
  min_answer: string; // ns the agent must have had to act for a delivered lure to count as Ignored; test_ttl/4 <= min_answer < test_ttl (V23-05)
  storage_deposit: string;
  min_near_float: string;
}

export interface VaultInit {
  owner_id: string;
  vendor_id: string;
  token_id: string;
  intents_id: string | null;
  policy: Policy;
}

export type Code = { kind: 'global'; codeHash: Uint8Array } | { kind: 'classic'; wasm: Uint8Array };

/** scripts/fixtures/policy-testnet.json (tUSDC, 6 decimals); test/vault.plan.test.ts keeps them equal. */
export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  daily_cap: '5000000',
  max_per_payment: '2000000',
  max_new_payees_per_day: 5,
  max_payments_per_day: 20,
  max_decisions_per_day: 100,
  batch_size: 3,
  batch_interval: '21600000000000',
  test_ttl: '43200000000000',
  reveal_grace: '21600000000000',
  rearm_cooldown: '3600000000000',
  payee_delay: '3600000000000',
  limits_delay: '86400000000000',
  key_allowance: '250000000000000000000000',
  key_nonces: 4,
  min_answer: '14400000000000',
  storage_deposit: '1250000000000000000000',
  min_near_float: '500000000000000000000000',
});

export const YOCTO_PER_NEAR = 10n ** 24n;
const BYTE = 10n ** 19n; // storage staking, yocto per byte
const STATE_BYTES = 600n; // vault state right after `new` (572 B measured), rounded up
const HEADROOM = YOCTO_PER_NEAR / 10n; // a few hundred decisions before the owner tops up
const GAS_KEY_BASE_BYTES = 120n; // nearcore stores about 85 B per nonce lane plus the key itself (contract 2.3.0 gas_key_cost)
const GAS_KEY_LANE_BYTES = 85n;
const MIN_FLOAT = YOCTO_PER_NEAR / 10n;
// V23-14: the contract allows 1 NEAR (DeleteKey's burn limit); at 0.5 NEAR blocking a demotion costs a griefer at least 0.5 NEAR
export const MAX_GAS_KEY_ALLOWANCE = YOCTO_PER_NEAR / 2n;
export const MAX_KEY_NONCES = 64;
// Self-serve floor (NF-06): a shorter payee_delay lets the owner delist and commit in the block of an agent read (V2-04).
export const MIN_PLAN_PAYEE_DELAY_NS = 3_600_000_000_000n;
export const DEFAULT_POLICY_DECIMALS = 6; // DEFAULT_POLICY caps are tUSDC base units

/** NEAR the first arming takes from the vault when the agent key is a gas key: its funding plus lane storage. */
export const gasKeyCost = (p: Policy): bigint =>
  (p.key_nonces ?? 0) > 0 ? BigInt(p.key_allowance) + (GAS_KEY_BASE_BYTES + GAS_KEY_LANE_BYTES * BigInt(p.key_nonces ?? 0)) * BYTE : 0n;

/** accept_key also needs key_allowance free beyond the gas key, held once Armed for the demotion re-key (V23-08). */
export const rekeyReserve = (p: Policy): bigint => ((p.key_nonces ?? 0) > 0 ? BigInt(p.key_allowance) : 0n);

/** Least NEAR a new vault needs: its storage, the reveal float (the contract refuses writes below it), the first gas-key arming, its re-key reserve and headroom. */
export const minFunding = (c: Code, policy: Policy): bigint => {
  const code = c.kind === 'classic' ? BigInt(c.wasm.length) : 0n;
  return (code + STATE_BYTES) * BYTE + BigInt(policy.min_near_float) + gasKeyCost(policy) + rekeyReserve(policy) + HEADROOM;
};

/** Refuses policies the contract or the tester would reject later, before anything is signed. */
export const checkPolicy = (p: Policy): string[] => {
  const errs: string[] = [];
  const ns = (v: string) => BigInt(v);
  if (p.batch_size < 1) errs.push('batch_size must be at least 1');
  if (ns(p.test_ttl) <= 0n) errs.push('test_ttl must be positive');
  if (ns(p.reveal_grace) < BigInt(MIN_REVEAL_GRACE_MS) * 1_000_000n) errs.push(`reveal_grace must be at least ${MIN_REVEAL_GRACE_MS / 1000} s for tlock`);
  if (p.max_payments_per_day < 1 || p.max_decisions_per_day < 1) errs.push('max_payments_per_day and max_decisions_per_day must be at least 1');
  if (BigInt(p.max_per_payment) > BigInt(p.daily_cap)) errs.push('max_per_payment above daily_cap');
  if (BigInt(p.key_allowance) <= 0n) errs.push('key_allowance must be positive (never unlimited)');
  if (BigInt(p.min_near_float) < MIN_FLOAT) errs.push('min_near_float below 0.1 NEAR leaves too little for reveals');
  if (BigInt(p.key_allowance) * 2n > BigInt(p.min_near_float)) errs.push('key_allowance must be at most half of min_near_float (V21-01)');
  const lanes = p.key_nonces ?? 0;
  if (!Number.isInteger(lanes) || lanes < 0 || lanes > MAX_KEY_NONCES) errs.push('key_nonces must be an integer from 0 (classic key) to 64 (gas key lanes)');
  // DeleteKey fails above 1 NEAR, so a donor topping the key up can block demotion and freeze; half that makes it cost them (V23-14)
  if (lanes > 0 && BigInt(p.key_allowance) > MAX_GAS_KEY_ALLOWANCE) errs.push('key_allowance must be at most 0.5 NEAR when the agent key is a gas key (V23-14)');
  // V23-05: the contract's floor is test_ttl / 4 with integer division, so mirror it exactly
  if (typeof p.min_answer !== 'string' || !/^\d{1,20}$/.test(p.min_answer)) errs.push('min_answer is required (ns string)');
  else if (ns(p.min_answer) === 0n || ns(p.min_answer) < ns(p.test_ttl) / 4n || ns(p.min_answer) >= ns(p.test_ttl)) errs.push('min_answer must be positive, at least test_ttl / 4 and below test_ttl');
  return errs;
};

/** What checkPolicy enforces, in words, for forms that build a policy. */
export const POLICY_BOUNDS: Readonly<Record<string, string>> = Object.freeze({
  batch_size: 'at least 1',
  test_ttl: 'positive, ns',
  reveal_grace: `at least ${MIN_REVEAL_GRACE_MS / 1000} s (${BigInt(MIN_REVEAL_GRACE_MS) * 1_000_000n} ns) for tlock`,
  max_payments_per_day: 'at least 1',
  max_decisions_per_day: 'at least 1',
  max_per_payment: 'at most daily_cap (token base units)',
  daily_cap: 'token base units, rolling 24 h; the defaults are 6-decimal units, scaled to the token in plans',
  payee_delay: `ns; self-serve plans need at least 1 h (${MIN_PLAN_PAYEE_DELAY_NS} ns)`,
  key_allowance: 'positive yocto, at most half of min_near_float; at most 0.5 NEAR (500000000000000000000000) when key_nonces > 0 (V23-14)',
  min_near_float: 'at least 0.1 NEAR (yocto)',
  key_nonces: 'integer 0 (classic function-call key) to 64 (gas key lanes)',
  min_answer: 'ns, at least test_ttl / 4 and below test_ttl',
  storage_deposit: "yocto, at least the token's storage_balance_bounds.min",
});

// The Verifier contract; reference/docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits.md
export const MAINNET_INTENTS_ID = 'intents.near';

/**
 * Checks the `intents_id` a vault would pay into on the Intents rail. Mainnet: only the Verifier contract.
 * Testnet: Intents has no deployment (reference/docs.near-intents.org/resources/faqs.md), so only with
 * `allowUnverified` for local sandbox experiments. Returns the reasons to refuse.
 */
export const checkIntents = (network: 'testnet' | 'mainnet', intentsId: string | null, allowUnverified: boolean): string[] => {
  if (intentsId === null) return [];
  if (!isValidAccountId(intentsId)) return [`--intents ${intentsId} is not a valid NEAR account id`];
  if (network === 'mainnet')
    return intentsId === MAINNET_INTENTS_ID ? [] : [`--intents must be ${MAINNET_INTENTS_ID} on mainnet (the NEAR Intents Verifier contract), got ${intentsId}`];
  return allowUnverified
    ? []
    : [`NEAR Intents has no testnet deployment (docs.near-intents.org, FAQ), so --intents ${intentsId} cannot be verified; pass --allow-unverified-intents only for a local sandbox experiment`];
};
