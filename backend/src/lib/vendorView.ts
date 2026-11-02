import type { Policy, Scorecard, Status } from './near/shop.ts';

// Vendor-facing events: the key lifecycle the vendor co-signs, and test outcomes that move it.
export const VENDOR_EVENTS = ['key_proposed', 'agent_armed', 'agent_key_changed', 'agent_demoted', 'agent_frozen', 'test_revealed', 'declined'] as const;

// accept_key: optional DeleteKey, AddKey and a 10 Tgas callback; about 15 Tgas measured, unused gas is refunded
export const ACCEPT_KEY_GAS = '30000000000000';

/** ns at which propose_key opens again after a demotion (the contract's rearm cooldown); null if never demoted. */
export const cooldownEndsAt = (status: Pick<Status, 'demoted_at'>, policy: Pick<Policy, 'rearm_cooldown'>): string | null =>
  BigInt(status.demoted_at) > 0n ? (BigInt(status.demoted_at) + BigInt(policy.rearm_cooldown)).toString() : null;

/** ms Date to the contract's ns string; indexed block times have ms precision. */
export const dateToNs = (d: Date): string => (BigInt(d.getTime()) * 1_000_000n).toString();

const HOUR_NS = 3_600_000_000_000n;

/** Policy fields that keep the owner from framing the agent (V2-04, V23-05), raw as get_policy returns them. */
export const fairnessOf = (p: Policy) => ({
  payee_delay: p.payee_delay,
  min_answer: p.min_answer ?? null,
  test_ttl: p.test_ttl,
  reveal_grace: p.reveal_grace,
  batch_size: p.batch_size,
  batch_interval: p.batch_interval,
  limits_delay: p.limits_delay,
  rearm_cooldown: p.rearm_cooldown,
});

/** NF-06: settings the contract allows but that leave the agent little room against a hostile owner. */
export const fairnessWarnings = (p: Policy): string[] => {
  const w: string[] = [];
  if (BigInt(p.payee_delay) < HOUR_NS) w.push('payee_delay_under_1h');
  if (BigInt(p.limits_delay) === 0n) w.push('limits_delay_zero');
  if (p.min_answer !== undefined && BigInt(p.min_answer) <= BigInt(p.test_ttl) / 4n) w.push('min_answer_at_floor');
  return w;
};

/** Facts only the indexer has: when the pending key was proposed (ns) and the key of the last successful arming. */
export interface IndexedKeyFacts {
  pendingKeyProposedAt?: string | null;
  lastArmedKey?: string | null;
}

/**
 * GET /vendor/me body, built from live contract views. `acceptKey` is the wallet call that arms the owner's proposed key.
 * `pendingKeyMatchesArmed` is null without a pending key, else whether it is the key the vendor last armed (NF-06).
 */
export const vendorView = (vault: string, network: string, status: Status, policy: Policy, scorecard: Scorecard, indexed: IndexedKeyFacts = {}) => ({
  vault,
  network,
  vendorId: status.vendor_id,
  ownerId: status.owner_id,
  mode: status.mode,
  agentKey: status.agent_key,
  pendingKey: status.pending_key,
  pendingKeyProposedAt: status.pending_key ? (indexed.pendingKeyProposedAt ?? null) : null,
  pendingKeyMatchesArmed: status.pending_key ? status.pending_key === indexed.lastArmedKey : null,
  cooldownEndsAt: cooldownEndsAt(status, policy),
  armedAt: status.armed_at,
  demotedAt: status.demoted_at,
  staleKey: status.stale_key ?? null,
  scorecard,
  limits: {
    max_per_payment: policy.max_per_payment,
    daily_cap: policy.daily_cap,
    max_payments_per_day: policy.max_payments_per_day,
    max_decisions_per_day: policy.max_decisions_per_day,
    max_new_payees_per_day: policy.max_new_payees_per_day,
    rearm_cooldown: policy.rearm_cooldown,
    key_nonces: policy.key_nonces ?? 0,
    key_allowance: policy.key_allowance,
  },
  fairness: fairnessOf(policy),
  fairnessWarnings: fairnessWarnings(policy),
  acceptKey: status.pending_key
    ? { receiverId: vault, methodName: 'accept_key', args: { public_key: status.pending_key }, gas: ACCEPT_KEY_GAS, deposit: '1' }
    : null,
});
