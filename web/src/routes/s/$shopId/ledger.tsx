import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { LedgerDownload } from '@/components/Downloads'
import MiniFooter from '@/components/MiniFooter'
import SiteNav from '@/components/SiteNav'
import { EmptyState, ErrorState, Skel } from '@/components/QueryState'
import { useLedger } from '@/hooks/useShop'
import { config } from '@/config'
import { short } from '@/utils/near'

export const Route = createFileRoute('/s/$shopId/ledger')({
  head: ({ params }) => ({
    meta: [{ title: `Ledger · ${params.shopId}` }],
  }),
  component: Ledger,
})

const TYPE_LABEL: Record<string, string> = {
  payment: 'Payment',
  proposal: 'Proposal',
  decline: 'Decline',
  test_reveal: 'Test',
}

// Links come from the API's CSV; render only explorer transaction URLs.
const TxA = ({ url }: { url: string }) =>
  url.startsWith(`${config.explorerUrl}/txns/`) ? (
    <a className="txl" href={url} target="_blank" rel="noreferrer">
      {short(url.split('/').pop(), 6, 4)}
    </a>
  ) : null

function Ledger() {
  const { shopId } = Route.useParams()
  const ledger = useLedger(shopId)
  const [type, setType] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const rows = useMemo(() => ledger.data ?? [], [ledger.data])
  const types = useMemo(() => [...new Set(rows.map((r) => r.type))], [rows])
  const shown = rows
    .filter((r) => type === 'all' || r.type === type)
    .filter((r) => !from || r.date_utc >= from)
    .filter((r) => !to || r.date_utc < to)
    .reverse()

  return (
    <div className="pg-new pg-ledger">
      <SiteNav />
      <main>
        <section className="wrap phero">
          <div className="crumbs">
            <Link className="label" to="/s/$shopId" params={{ shopId }}>
              Scorecard
            </Link>
            <span className="label">/</span>
            <span className="chip">{shopId}</span>
          </div>
          <h1 className="disp">
            <span className="mline">
              <span>Ledger.</span>
            </span>
          </h1>
          <p className="dimt" style={{ maxWidth: '62ch' }}>
            Every payment, proposal, decline and test slot on this vault,
            rebuilt from its on-chain events. Each row links to the transaction
            that recorded it. Internal control tests are labelled, so an
            accountant can tell them from real spending.
          </p>
        </section>
        <section className="wrap lg-body">
          <div className="lg-filters">
            <div className="seg" role="group" aria-label="Type">
              {['all', ...types].map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={t === type}
                  onClick={() => setType(t)}
                >
                  {t === 'all' ? 'All' : (TYPE_LABEL[t] ?? t)}
                </button>
              ))}
            </div>
            <div className="field">
              <label htmlFor="lv-from">From (UTC)</label>
              <input
                id="lv-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="lv-to">To, not included</label>
              <input
                id="lv-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          {ledger.isError ? (
            <ErrorState
              what="the ledger"
              error={ledger.error}
              retry={() => ledger.refetch()}
            />
          ) : ledger.isPending ? (
            <Skel h={240} />
          ) : !shown.length ? (
            <EmptyState title="No rows">
              {rows.length
                ? 'Nothing matches these filters.'
                : 'This vault has no payments, proposals, declines or revealed tests yet.'}
            </EmptyState>
          ) : (
            <div className="panel" style={{ padding: '8px 8px 0' }}>
              <div className="tbox">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Date, UTC</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Amount</th>
                      <th className="hide-sm">Payee</th>
                      <th className="hide-sm">Invoice</th>
                      <th className="hide-sm">Note</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={`${r.date_utc}-${r.tx_link}-${i}`}>
                        <td className="m">{r.date_utc.slice(5, 16)}</td>
                        <td>
                          <span
                            className={`chip${r.type === 'test_reveal' ? ' dash' : ''}`}
                          >
                            {TYPE_LABEL[r.type] ?? r.type}
                          </span>
                        </td>
                        <td className="m">{r.status}</td>
                        <td className="m">
                          {r.amount ? `${r.amount} ${r.token}` : ''}
                        </td>
                        <td className="m hide-sm">{short(r.payee, 12, 8)}</td>
                        <td className="m hide-sm">
                          {short(r.invoice_id, 6, 4)}
                        </td>
                        <td className="hide-sm lg-note">
                          {[r.reference, r.note].filter(Boolean).join(' · ')}
                        </td>
                        <td className="m">
                          <TxA url={r.tx_link} />
                          {r.status_tx_link &&
                            r.status_tx_link !== r.tx_link && (
                              <>
                                {' '}
                                <TxA url={r.status_tx_link} />
                              </>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="mono dimt" style={{ fontSize: 12.5 }}>
            {shown.length} of {rows.length} rows{' '}
            <span className="src">GET /public/ledger/:shopId</span>
          </p>
          <div className="panel" style={{ display: 'grid', gap: 12 }}>
            <h3>Download for a spreadsheet</h3>
            <LedgerDownload shopId={shopId} />
          </div>
        </section>
      </main>
      <MiniFooter note="Built from on-chain events · every row links to its transaction" />
    </div>
  )
}
