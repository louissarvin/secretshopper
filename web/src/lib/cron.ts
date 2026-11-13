// The tester's commitCron is daily, "M H * * *" in UTC (PUT /company/tester in backend/API.md)
const DAILY = /^([0-5]?\d) ([01]?\d|2[0-3]) \* \* \*$/

/** The first daily run at or after `from` (ms), or null for any other cron shape. */
export function nextDailyRun(cron: string, from: number): number | null {
  const m = DAILY.exec(cron.trim())
  if (!m) return null
  const d = new Date(from)
  let t = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    Number(m[2]),
    Number(m[1]),
  )
  if (t < from) t += 86_400_000
  return t
}
