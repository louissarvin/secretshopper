import type { Mode, Policy } from '@/lib/near/types'

// Mirrors reserve(), free_near() and gas_key_cost() in contracts/shop/src/lib.rs
const BYTE = 10n ** 19n
const REVEAL_BYTES = 600n
const FLUSH_MARGIN_BYTES = 2_000n
const GAS_KEY_LANE_EXTRA_BYTES = 4n + 8n + 40n
const GAS_KEY_BASE_BYTES = 300n
const PK_BYTES = 33n // ed25519 key type byte plus 32

export interface VaultFunds {
  balance: bigint
  reserved: bigint
  free: bigint
  /** Free NEAR accept_key requires: 0 for a classic agent key */
  armNeed: bigint
  /** How much the owner must add before the vendor can accept */
  armShortfall: bigint
}

export function vaultFunds(o: {
  amount: string
  storageUsage: number
  policy: Pick<Policy, 'min_near_float' | 'key_nonces' | 'key_allowance'>
  mode: Mode
  openSlots: number
}): VaultFunds {
  const balance = BigInt(o.amount)
  const nonces = BigInt(o.policy.key_nonces)
  const allowance = BigInt(o.policy.key_allowance)
  const float = BigInt(o.policy.min_near_float)
  const owed = BigInt(o.openSlots) * REVEAL_BYTES * BYTE
  const rekey = nonces > 0n && o.mode === 'Armed' ? allowance : 0n
  const reserved =
    BigInt(o.storageUsage) * BYTE + (float > owed ? float : owed) + rekey
  const free = balance > reserved ? balance - reserved : 0n
  const gasKey =
    (nonces * (PK_BYTES + GAS_KEY_LANE_EXTRA_BYTES) +
      PK_BYTES +
      GAS_KEY_BASE_BYTES +
      FLUSH_MARGIN_BYTES) *
      BYTE +
    allowance
  const armNeed = nonces > 0n ? gasKey + allowance : 0n
  return {
    balance,
    reserved,
    free,
    armNeed,
    armShortfall: armNeed > free ? armNeed - free : 0n,
  }
}

/** Rounds a top-up up to 0.01 NEAR, so the suggested amount always covers the shortfall */
export const topUpNear = (yocto: bigint) => {
  const step = 10n ** 22n
  const n = (yocto + step - 1n) / step
  return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`
}
