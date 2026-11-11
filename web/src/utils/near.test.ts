// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fmtPolicy } from './near'

describe('fmtPolicy shows contract units the way a person reads them', () => {
  it('token base units, yoctoNEAR and nanoseconds', () => {
    expect(fmtPolicy('daily_cap', '5000000', 'tUSDC', 6)).toBe('5.00 tUSDC')
    expect(fmtPolicy('key_allowance', '250000000000000000000000', '', 6)).toBe(
      '0.2500 NEAR',
    )
    expect(fmtPolicy('rearm_cooldown', '3600000000000', '', 6)).toBe('1 h')
    expect(fmtPolicy('min_answer', '14400000000000', '', 6)).toBe('4 h')
    expect(fmtPolicy('reveal_grace', '9000000000', '', 6)).toBe('9 s')
  })

  it('counts and unknown fields pass through', () => {
    expect(fmtPolicy('key_nonces', 4, '', 6)).toBe('4')
    expect(fmtPolicy('batch_size', '3', '', 6)).toBe('3')
  })
})
