import { useScorecard, useThroughput } from '@/hooks/useShop'

/**
 * The lure score beside how the agent treated genuine invoices, so an agent that declines everything cannot look
 * perfect. Counts come from GET /public/throughput and stop at its asOf cutoff.
 */
export default function TwoSided({ shopId }: { shopId: string }) {
  const sc = useScorecard(shopId)
  const t = useThroughput(shopId)
  if (!t.data) return null
  const d = t.data
  const caught = sc.data?.score_bps
  const paid = d.autoPaid + d.approvedByOwner
  return (
    <div className="twosided">
      <p>
        {caught != null && (
          <>
            Lures caught <b>{(caught / 100).toFixed(2)}%</b> ·{' '}
          </>
        )}
        Genuine invoices paid{' '}
        <b>
          {paid} of {d.delivered}
        </b>
        {d.approvedByOwner > 0 &&
          ` (${d.approvedByOwner} after the owner approved a proposal)`}
      </p>
      <p className="tsd">
        {d.proposed} escalated to a person, {d.declined} declined
        {d.undecided ? `, ${d.undecided} undecided` : ''}. Real invoices
        delivered before {d.asOf.slice(0, 16).replace('T', ' ')} UTC
        {d.excludedOpenWindow
          ? '; newer ones wait until the tests they could hide among are revealed.'
          : '.'}{' '}
        <span className="src">GET /public/throughput/:shopId</span>
      </p>
    </div>
  )
}
