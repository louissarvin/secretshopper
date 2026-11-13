// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { nextDailyRun } from './cron'

describe('next daily tester run', () => {
  const allowed = Date.parse('2026-11-13T11:51:15Z')
  it('takes the first run at or after the allowed time', () => {
    expect(nextDailyRun('0 0 * * *', allowed)).toBe(
      Date.parse('2026-11-14T00:00:00Z'),
    )
    expect(nextDailyRun('55 11 * * *', allowed)).toBe(
      Date.parse('2026-11-13T11:55:00Z'),
    )
    expect(nextDailyRun('51 11 * * *', allowed)).toBe(
      Date.parse('2026-11-14T11:51:00Z'),
    )
  })
  it('refuses anything but a daily schedule', () => {
    for (const c of ['*/5 * * * *', '0 0 * * 1', '60 0 * * *', '0 24 * * *'])
      expect(nextDailyRun(c, allowed)).toBeNull()
  })
})
