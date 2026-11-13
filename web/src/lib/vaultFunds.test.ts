// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { topUpNear, vaultFunds } from './vaultFunds'

const NEAR = 10n ** 24n
// selfserve-e2e on testnet, 2026-11-13: accept_key failed at 1 NEAR and passed after a 1 NEAR top-up
const policy = {
  min_near_float: String(NEAR / 2n),
  key_nonces: 4,
  key_allowance: String(NEAR / 4n),
}

describe('vault NEAR, as accept_key checks it', () => {
  it('finds the shortfall that made accept_key fail', () => {
    const f = vaultFunds({
      amount: String(NEAR),
      storageUsage: 1075,
      policy,
      mode: 'Unarmed',
      openSlots: 0,
    })
    expect(f.armShortfall > 0n).toBe(true)
    expect(topUpNear(f.armShortfall)).toBe('0.04')
    const after = vaultFunds({
      amount: String(NEAR + 10n ** 24n),
      storageUsage: 1075,
      policy,
      mode: 'Unarmed',
      openSlots: 0,
    })
    expect(after.armShortfall).toBe(0n)
  })

  it('reserves the open reveals, the re-key once armed, and nothing for a classic key', () => {
    const armed = vaultFunds({
      amount: String(2n * NEAR),
      storageUsage: 0,
      policy,
      mode: 'Armed',
      openSlots: 1000,
    })
    // 1000 open slots owe 6 NEAR of reveal storage, more than the 0.5 float
    expect(armed.reserved).toBe(6n * NEAR + NEAR / 4n)
    expect(armed.free).toBe(0n)
    const classic = vaultFunds({
      amount: '0',
      storageUsage: 0,
      policy: { ...policy, key_nonces: 0 },
      mode: 'Unarmed',
      openSlots: 0,
    })
    expect(classic.armNeed).toBe(0n)
    expect(classic.armShortfall).toBe(0n)
  })
})
