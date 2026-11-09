import { useNow } from '@/hooks/useMotion'
import { useSchedule } from '@/hooks/useShop'
import { clock, utcStamp } from '@/utils/near'

/** When the inbox next releases and when the next test batch may come, from GET /public/schedule. */
export default function ScheduleLine({ shopId }: { shopId: string }) {
  const s = useSchedule(shopId)
  const now = useNow()
  if (!s.data || !now) return null
  const d = s.data
  const release = Date.parse(d.nextReleaseAt)
  const batch = d.nextBatchEarliestAt ? Date.parse(d.nextBatchEarliestAt) : null
  const reveal = d.nextRevealAfter ? Date.parse(d.nextRevealAfter) : null
  return (
    <div className="sched" aria-live="off">
      <span>
        Next delivery tick in <b>{clock(Math.max(0, release - now))}</b> (
        {utcStamp(release)}, every {d.releaseTickMinutes / 60} h)
      </span>
      {batch !== null && (
        <span>
          Next test batch{' '}
          {batch > now ? (
            <>
              no earlier than <b>{utcStamp(batch)}</b>
            </>
          ) : (
            'allowed now; the tester commits on its daily run'
          )}
        </span>
      )}
      {d.pending > 0 && reveal !== null && (
        <span>
          {d.pending} sealed, opening after <b>{utcStamp(reveal)}</b>
        </span>
      )}
      <span className="src">GET /public/schedule/:shopId</span>
    </div>
  )
}
