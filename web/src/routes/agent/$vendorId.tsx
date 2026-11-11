import { Link, createFileRoute } from '@tanstack/react-router'
import MiniFooter from '@/components/MiniFooter'
import SiteNav from '@/components/SiteNav'
import { EmptyState, ErrorState, Skel } from '@/components/QueryState'
import { useAgentReputation } from '@/hooks/useShop'
import { ApiError } from '@/lib/api/client'
import { explorerAccount } from '@/config'
import { short } from '@/utils/near'

export const Route = createFileRoute('/agent/$vendorId')({
  head: ({ params }) => ({
    meta: [{ title: `Agent record · ${params.vendorId}` }],
  }),
  component: AgentRecord,
})

const pct = (bps: number | null | undefined) =>
  bps == null ? '–' : `${(bps / 100).toFixed(2)}%`

function AgentRecord() {
  const { vendorId } = Route.useParams()
  const r = useAgentReputation(vendorId)
  const busy = r.error instanceof ApiError && r.error.code === 'REPUTATION_BUSY'
  const a = r.data?.aggregate

  return (
    <div className="pg-new pg-ledger">
      <SiteNav />
      <main>
        <section className="wrap phero">
          <div className="crumbs">
            <span className="label">Agent vendor</span>
            <a
              className="chip"
              href={explorerAccount(vendorId)}
              target="_blank"
              rel="noreferrer"
            >
              {vendorId}
            </a>
          </div>
          <h1 className="disp">
            <span className="mline">
              <span>Track</span>
            </span>
            <span className="mline">
              <span className="cob">record.</span>
            </span>
          </h1>
          <p className="dimt" style={{ maxWidth: '62ch' }}>
            Every vault this vendor armed an agent key on, read from the chain,
            with each vault's own scorecard and the results pooled.
          </p>
        </section>
        <section className="wrap lg-body">
          {busy ? (
            <div className="state err" role="alert">
              <b>The API is busy reading the chain</b>
              <p>Try again in a minute.</p>
            </div>
          ) : r.isError ? (
            <ErrorState
              what="this vendor's record"
              error={r.error}
              retry={() => r.refetch()}
            />
          ) : !r.data || !a ? (
            <Skel h={260} />
          ) : (
            <>
              <div className="kpis-row">
                <div className="panel">
                  <span className="label">Pooled score</span>
                  <span className="vnum">{pct(a.scoreBps)}</span>
                  <p className="dimt">
                    {a.passed} passed, {a.failed} failed
                    {a.failedContained
                      ? `, ${a.failedContained} caught by limits`
                      : ''}
                    , {a.ignored} ignored
                  </p>
                </div>
                <div className="panel">
                  <span className="label">Vaults</span>
                  <span className="vnum">{a.vaults}</span>
                  <p className="dimt">
                    {a.distinctOwners} distinct{' '}
                    {a.distinctOwners === 1 ? 'owner' : 'owners'}
                  </p>
                </div>
                <div className="panel">
                  <span className="label">Demotions</span>
                  <span className="vnum">{a.demotions}</span>
                  <p className="dimt">{a.unanswered} unanswered, not scored</p>
                </div>
              </div>
              <div className="panel caveat-box" role="note">
                <span className="label">Read this first</span>
                <p>{r.data.caveat}</p>
                {(r.data.truncated.txs || r.data.truncated.vaults) && (
                  <p className="sheet-err">
                    The scan stopped early, so this record may miss vaults.
                  </p>
                )}
              </div>
              {!r.data.vaults.length ? (
                <EmptyState title="No vaults yet">
                  This account has not armed an agent key on any vault.
                </EmptyState>
              ) : (
                <div className="panel" style={{ padding: '8px 8px 0' }}>
                  <div className="tbox">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>Vault</th>
                          <th className="hide-sm">Owner</th>
                          <th>Mode</th>
                          <th>Score</th>
                          <th className="hide-sm">Demotions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.data.vaults.map((v) => (
                          <tr key={v.vaultId}>
                            <td className="m">
                              <Link
                                className="txl"
                                to="/s/$shopId"
                                params={{ shopId: v.vaultId }}
                              >
                                {short(v.vaultId, 14, 10)}
                              </Link>
                            </td>
                            <td className="m hide-sm">
                              {short(v.ownerId, 12, 8)}
                              {v.ownedByVendor && (
                                <>
                                  {' '}
                                  <span className="chip solid">
                                    vendor's own
                                  </span>
                                </>
                              )}
                            </td>
                            <td>
                              <span className="chip">{v.mode}</span>
                            </td>
                            <td className="m">{pct(v.scorecard?.score_bps)}</td>
                            <td className="m hide-sm">{v.demotions}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
          <p className="mono dimt" style={{ fontSize: 12.5 }}>
            <span className="src">GET /public/agent/:vendorId</span>
          </p>
        </section>
      </main>
      <MiniFooter note="An agent's record across every vault it was armed on" />
    </div>
  )
}
