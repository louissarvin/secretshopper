// Shapes returned by contracts/shop/src/lib.rs 2.3.0. U128/U64 are decimal strings, times are nanoseconds.

export type Mode = 'Unarmed' | 'Armed' | 'Demoted' | 'Frozen'
export type Rail = 'Near' | 'Intents'
export type TestStatus =
  | 'Committed'
  | 'Passed'
  | 'Failed'
  | 'Unanswered'
  | 'Void'
  | 'Invalid'
  | 'Misdirected'
  | 'Ignored'
export type TxStatus =
  | 'Pending'
  | 'Settled'
  | 'Failed'
  | 'Approved'
  | 'Rejected'

export interface Status {
  mode: Mode
  agent_key: string | null
  pending_key: string | null
  armed_at: string
  demoted_at: string
  spent_24h: string
  owner_id: string
  vendor_id: string
  token_id: string
  intents_id: string | null
  version: string
  stale_key: string | null
}

export interface Policy {
  daily_cap: string
  max_per_payment: string
  max_new_payees_per_day: number
  max_payments_per_day: number
  max_decisions_per_day: number
  batch_size: number
  batch_interval: string
  test_ttl: string
  reveal_grace: string
  rearm_cooldown: string
  payee_delay: string
  limits_delay: string
  key_allowance: string
  storage_deposit: string
  min_near_float: string
  key_nonces: number
  min_answer: string
}

export interface Stats {
  committed: number
  passed: number
  failed: number
  failed_contained: number
  unanswered: number
  void: number
  invalid: number
  misdirected: number
  ignored: number
  releases_posted: number
  acks_matched: number
  acks_mismatched: number
  payments: number
  paid_total: string
  declines: number
  proposals: number
  demotions: number
}

export interface Scorecard {
  mode: Mode
  agent_key: string | null
  stats: Stats
  score_bps: number | null
  pending: number
  overdue_unrevealed: number
  spent_24h: string
  now: string
}

export interface Limits {
  daily_cap: string
  max_per_payment: string
  max_new_payees_per_day: number
}

export interface PendingLimits {
  limits: Limits
  effective_at: string
}

export interface TestSlot {
  commitment: string
  batch: number
  committed_at: string
  expires_at: string
  tlock_round: number
  ciphertext_sha256: string
  status: TestStatus
  contained: boolean
  demoted: boolean
  reveal: {
    payee: string
    invoice_id: string
    receipt_hash: string
    salt: string
    at: string
    by: string
  } | null
}

export interface Decision {
  kind: 'Paid' | 'Declined' | 'Proposed'
  payee: string | null
  payee_approved: boolean
  amount: string
  at: string
  key: string
  ref_id: number
}

export interface Payment {
  invoice_id: string
  payee: string
  amount: string
  rail: Rail
  status: TxStatus
  by_owner: boolean
  at: string
}

export interface Proposal {
  invoice_id: string
  payee: string
  amount: string
  rail: Rail
  status: TxStatus
  at: string
}

export interface ApprovedPayee {
  account_id: string
  label: string
  active_at: string
  removed_at: string | null
}

export interface Release {
  root: string
  count: number
  at: string
  ack: { root: string; at: string; key: string } | null
}

export interface Batch {
  first_slot: number
  count: number
  committed_at: string
  expires_at: string
  unrevealed: number
}

// RPC view_access_key_list
export interface AccessKeyInfo {
  public_key: string
  access_key: { nonce: number; permission: unknown }
}

export const nsToMs = (ns: string | number) =>
  Number(BigInt(String(ns)) / 1_000_000n)
export const msToNs = (ms: number) =>
  (BigInt(Math.round(ms)) * 1_000_000n).toString()
