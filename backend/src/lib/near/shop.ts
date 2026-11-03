import { view } from './client.ts';

// JSON shapes of the v2 shop contract views (contracts/shop/src/lib.rs). Amounts are U128 strings, times are U64 ns strings.
export type Mode = 'Unarmed' | 'Armed' | 'Demoted' | 'Frozen';
export type Rail = 'Near' | 'Intents';
export type TestStatus = 'Committed' | 'Passed' | 'Failed' | 'Unanswered' | 'Ignored' | 'Void' | 'Invalid' | 'Misdirected';
export const TEST_STATUSES: readonly TestStatus[] = ['Committed', 'Passed', 'Failed', 'Unanswered', 'Ignored', 'Void', 'Invalid', 'Misdirected'];

export interface Decision {
  kind: 'Paid' | 'Declined' | 'Proposed';
  payee: string | null;
  payee_approved: boolean;
  amount: string;
  at: string;
  key: string;
  ref_id: number; // decline reasons live only in the declined event
}

export interface ChainTestSlot {
  commitment: string;
  batch: number;
  committed_at: string;
  expires_at: string;
  status: TestStatus;
  contained: boolean;
  tlock_round: number;
  ciphertext_sha256: string;
  demoted: boolean;
  reveal: { payee: string; invoice_id: string; receipt_hash: string; salt: string; at: string; by: string } | null;
}

export interface ChainBatch {
  first_slot: number;
  count: number;
  committed_at: string;
  expires_at: string;
  unrevealed: number;
}

/** v2 on-chain approved payee: active while active_at <= t < removed_at (both delays are policy.payee_delay). */
export interface ApprovedPayee {
  account_id: string;
  label: string;
  active_at: string;
  removed_at: string | null;
}

export const isPayeeActive = (p: Pick<ApprovedPayee, 'active_at' | 'removed_at'>, nowMs: number): boolean => {
  const t = BigInt(nowMs) * 1_000_000n;
  return BigInt(p.active_at) <= t && (p.removed_at === null || t < BigInt(p.removed_at));
};

export interface Policy {
  daily_cap: string; // rolling 24 h
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
  key_nonces?: number; // 0 or absent: classic function-call key; 1 to 1024: NEP-611 gas key lanes
  storage_deposit: string;
  min_near_float: string;
  min_answer?: string; // contract 2.3.0+: ns the agent must have had between release and expiry for Ignored; test_ttl/4 <= min_answer < test_ttl
}

export interface Status {
  mode: Mode;
  agent_key: string | null;
  pending_key: string | null;
  armed_at: string;
  demoted_at: string;
  spent_24h: string;
  version: string; // crate version; "2.x" is the v2 interface
  owner_id: string;
  vendor_id: string;
  token_id: string;
  intents_id: string | null;
  stale_key?: string | null; // contract 2.2.0+: key whose last change failed; anyone may call resync_key
  frozen_at?: string; // contract 2.3.0+: last freeze (ns), "0" if never; a freeze inside an answer window voids delivery proofs
}

/** First time the vault touched a payee; via_proposal = only a human-gated proposal or owner payment. */
export interface PayeeSeen {
  at: string;
  invoice_id?: string; // contract 2.2.0+: the decision that first touched the payee
  via_proposal: boolean;
  approved: boolean;
  key: string | null;
}

export interface Stats {
  committed: number;
  passed: number;
  failed: number;
  failed_contained: number;
  unanswered: number;
  ignored?: number; // contract 2.3.0+: delivered (acked release root) and undecided; scored as not passed
  releases_posted?: number; // contract 2.3.0+
  acks_matched?: number; // contract 2.3.0+: agent root equal to the tester's
  acks_mismatched?: number; // contract 2.3.0+: evidence of a forked inbox
  void: number;
  invalid: number;
  misdirected?: number; // contract 2.1.0+: lure invoice paid or proposed to another payee; shown, not scored
  payments: number;
  paid_total: string;
  declines: number;
  proposals: number;
  demotions: number;
}

export interface Scorecard {
  mode: Mode;
  agent_key: string | null;
  stats: Stats;
  score_bps: number | null; // passed / (passed + failed + failed_contained + ignored); unanswered (no delivery proof) is shown, not scored
  pending: number;
  overdue_unrevealed: number;
  spent_24h: string;
  now: string;
}

/** Release tick (contract 2.3.0+): the tester's root and, once signed, the agent's. */
export interface ChainRelease {
  root: string;
  count: number;
  at: string;
  ack: { root: string; at: string; key: string } | null;
}

/** Proof that a lure's invoice id is in an acked release root; passed to reveal on the Unanswered path. */
export interface DeliveryArg {
  release_at: string;
  index: number;
  proof: string[];
}

export const nsToDate = (ns: string | number | bigint): Date => new Date(Number(BigInt(ns) / 1_000_000n));

export const getStatus = (shop: string) => view<Status>(shop, 'get_status');
export const getPayee = (shop: string, accountId: string) => view<PayeeSeen | null>(shop, 'get_payee', { account_id: accountId });
export const getScorecard = (shop: string) => view<Scorecard>(shop, 'get_scorecard');
export const getPayees = (shop: string, from: number, limit: number) => view<ApprovedPayee[]>(shop, 'get_payees', { from, limit });
export const getPayeeStatus = (shop: string, accountId: string) => view<ApprovedPayee | null>(shop, 'get_payee_status', { account_id: accountId });
export const getBatches = (shop: string, from: number, limit: number) => view<ChainBatch[]>(shop, 'get_batches', { from, limit });

/** Every slot, paging get_tests until a short page (v2 scorecard no longer has to be walked). */
export const getAllTests = async (shop: string): Promise<ChainTestSlot[]> => {
  const out: ChainTestSlot[] = [];
  for (;;) {
    const page = await getTests(shop, out.length, 100);
    out.push(...page);
    if (page.length < 100) return out;
  }
};
export const getPolicy = (shop: string) => view<Policy>(shop, 'get_policy');
export const getTest = (shop: string, slotId: number) => view<ChainTestSlot | null>(shop, 'get_test', { slot_id: slotId });
export const getTests = (shop: string, from: number, limit: number) => view<ChainTestSlot[]>(shop, 'get_tests', { from, limit });
export const getRelease = (shop: string, releaseAtNs: string) => view<ChainRelease | null>(shop, 'get_release', { release_at: releaseAtNs });
export const getDecision = (shop: string, invoiceId: string) => view<Decision | null>(shop, 'get_decision', { invoice_id: invoiceId });

const STORAGE_BYTE_COST = 10n ** 19n; // yocto per byte (NEAR protocol constant)

const REVEAL_BYTES = 600n; // contract REVEAL_BYTES: storage one scored reveal needs (V21-05)

export interface ReserveInput {
  openSlots?: number; // committed, unrevealed slots (contract open_slots, no view exposes it), 0 before 2.1
  armedGasKey?: boolean; // mode Armed with policy.key_nonces > 0: one re-key is held back (V23-08)
  keyAllowanceYocto?: bigint;
}

/** NEAR above the contract's `reserve()`: storage, max(float, open reveals), plus the armed gas-key re-key. Writes fail below 0. */
export const floatHeadroom = (amountYocto: bigint, storageUsage: number, floatYocto: bigint, r: ReserveInput = {}): bigint => {
  const owed = BigInt(r.openSlots ?? 0) * REVEAL_BYTES * STORAGE_BYTE_COST;
  const rekey = r.armedGasKey ? (r.keyAllowanceYocto ?? 0n) : 0n;
  return amountYocto - BigInt(storageUsage) * STORAGE_BYTE_COST - (floatYocto > owed ? floatYocto : owed) - rekey;
};

const FLUSH_MARGIN_BYTES = 2_000n; // contract FLUSH_MARGIN_BYTES: assert_float also keeps this above reserve() (V21-02)

/** NEAR an agent or tester write can still use: `floatHeadroom` minus the flush margin `assert_float` adds (B23-06). */
export const writeHeadroom = (amountYocto: bigint, storageUsage: number, floatYocto: bigint, r: ReserveInput = {}): bigint =>
  floatHeadroom(amountYocto, storageUsage, floatYocto, r) - FLUSH_MARGIN_BYTES * STORAGE_BYTE_COST;
