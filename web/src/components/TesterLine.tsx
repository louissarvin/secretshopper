import { useQuery } from '@tanstack/react-query'
import { STATE_TEXT } from '@/components/TesterSetup'
import { useNow } from '@/hooks/useMotion'
import { useSchedule } from '@/hooks/useShop'
import { ApiError } from '@/lib/api/client'
import { ownerApi } from '@/lib/api/shop'
import { nextDailyRun } from '@/lib/cron'
import { ago, utcStamp } from '@/utils/near'

/** The tester's opt-in state and when it can next commit a batch on this vault. */
export default function TesterLine({ vault }: { vault: string }) {
  const now = useNow()
  const sched = useSchedule(vault)
  const t = useQuery({
    queryKey: ['owner', vault, 'tester'],
    queryFn: () => ownerApi.tester(vault),
    refetchInterval: 60_000,
    retry: (n, e: any) => ![400, 401, 403, 404].includes(e?.status) && n < 2,
  })
  // This deployment's own vault is tested from server settings, not per company
  if (t.error instanceof ApiError && t.error.code === 'DEFAULT_VAULT_ENV')
    return null
  if (!t.data || !now) return null
  const d = t.data
  const allowed = sched.data?.nextBatchEarliestAt
    ? Date.parse(sched.data.nextBatchEarliestAt)
    : null
  const from = Math.max(now, allowed ?? now)
  const run = d.commitCron ? nextDailyRun(d.commitCron, from) : null
  const checked = d.testerCheckedAt ? Date.parse(d.testerCheckedAt) : null

  return (
    <div className="sched" aria-live="off">
      <span>
        Tester <b>{d.enabled ? 'on' : 'off'}</b>
        {d.state ? ` · ${d.state}` : ''}
        {checked ? ` · last checked ${ago(checked, now)}` : ''}
        {d.enabled ? ` · tests ${d.testPercent}% of deliveries` : ''}
      </span>
      {d.state && STATE_TEXT[d.state] && <span>{STATE_TEXT[d.state]}</span>}
      {d.enabled && (
        <span>
          Next test batch{' '}
          {allowed && allowed > now ? (
            <>
              allowed from <b>{utcStamp(allowed)}</b>,{' '}
            </>
          ) : (
            'allowed now, '
          )}
          {run ? (
            <>
              committed at the tester's run at <b>{utcStamp(run)}</b>
            </>
          ) : (
            "committed at the tester's next daily run after that"
          )}
        </span>
      )}
      <span className="src">GET /company/tester · GET /public/schedule</span>
    </div>
  )
}
