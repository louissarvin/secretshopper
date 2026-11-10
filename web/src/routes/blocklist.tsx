import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { BlockEntry } from '@/lib/api/shop'
import MiniFooter from '@/components/MiniFooter'
import SiteNav from '@/components/SiteNav'
import { EmptyState, ErrorState, Skel } from '@/components/QueryState'
import { useBlocklist, useBlocklistOf } from '@/hooks/useShop'
import { explorerTx } from '@/config'
import { isAccountId, short } from '@/utils/near'

export const Route = createFileRoute('/blocklist')({
  head: () => ({ meta: [{ title: 'Payee blocklist · Secret Shopper' }] }),
  component: Blocklist,
})

const KIND: Record<string, string> = {
  tester: 'tester',
  owner: 'vault owner',
  agent: 'agent',
}

function Row({ e }: { e: BlockEntry }) {
  return (
    <tr>
      <td className="m">{e.createdAt.slice(0, 10)}</td>
      <td className="m bl-acct">{short(e.accountId, 14, 10)}</td>
      <td className="bl-reason">{e.reason}</td>
      <td className="hide-sm">
        <span className="chip">{KIND[e.reporterKind] ?? e.reporterKind}</span>
      </td>
      <td className="m hide-sm">{short(e.vault, 10, 8)}</td>
      <td className="m">
        <a
          className="txl"
          href={explorerTx(e.evidenceTx)}
          target="_blank"
          rel="noreferrer"
        >
          {short(e.evidenceTx, 6, 4)}
        </a>
        {e.verified ? '' : ' · unverified'}
      </td>
    </tr>
  )
}

function Lookup() {
  const [q, setQ] = useState('')
  const [id, setId] = useState<string>()
  const r = useBlocklistOf(id)
  return (
    <form
      className="panel"
      style={{ display: 'grid', gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault()
        if (isAccountId(q.trim())) setId(q.trim())
      }}
    >
      <h3>Check an account</h3>
      <div className="field">
        <label htmlFor="bl-q">NEAR account</label>
        <input
          id="bl-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="payee.testnet"
        />
      </div>
      <div>
        <button className="btn ghost sm" type="submit">
          Check
        </button>
      </div>
      {r.isError ? (
        <ErrorState what="this account" error={r.error} />
      ) : r.data ? (
        r.data.listed ? (
          <p className="sheet-err" role="alert">
            {r.data.accountId} is blocklisted ({r.data.count}{' '}
            {r.data.count === 1 ? 'report' : 'reports'}):{' '}
            {r.data.entries[0]?.reason}
          </p>
        ) : (
          <p className="dimt" style={{ fontSize: 14 }}>
            {r.data.accountId} is not on the blocklist.
          </p>
        )
      ) : null}
      <span className="src">GET /public/blocklist/:accountId</span>
    </form>
  )
}

function Blocklist() {
  const list = useBlocklist()
  const items = list.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <div className="pg-new pg-ledger">
      <SiteNav />
      <main>
        <section className="wrap phero">
          <div className="crumbs">
            <span className="label">Shared across vaults</span>
          </div>
          <h1 className="disp">
            <span className="mline">
              <span>Payee</span>
            </span>
            <span className="mline">
              <span className="cob">blocklist.</span>
            </span>
          </h1>
          <p className="dimt" style={{ maxWidth: '62ch' }}>
            Accounts proven to be lure payees: the tester adds every payee a
            test caught an agent paying, and an owner can report one with a
            transaction as proof. Each entry is checked against the chain before
            it is stored, and agents refuse to pay any account on it.
          </p>
        </section>
        <section className="wrap nv-grid">
          <div className="nv-l">
            {list.isError ? (
              <ErrorState
                what="the blocklist"
                error={list.error}
                retry={() => list.refetch()}
              />
            ) : list.isPending ? (
              <Skel h={200} />
            ) : !items.length ? (
              <EmptyState title="No entries yet">
                Payees appear here once a test proves an agent paid them.
              </EmptyState>
            ) : (
              <div className="panel" style={{ padding: '8px 8px 0' }}>
                <div className="tbox">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Listed</th>
                        <th>Account</th>
                        <th>Why</th>
                        <th className="hide-sm">By</th>
                        <th className="hide-sm">Vault</th>
                        <th>Proof</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((e) => (
                        <Row key={e.id} e={e} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {list.hasNextPage && (
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
                style={{ marginTop: 12 }}
              >
                Older
              </button>
            )}
            <p className="mono dimt" style={{ fontSize: 12.5, marginTop: 12 }}>
              <span className="src">GET /public/blocklist</span>
            </p>
          </div>
          <div className="nv-r">
            <Lookup />
          </div>
        </section>
      </main>
      <MiniFooter note="Every entry is backed by a transaction on chain" />
    </div>
  )
}
