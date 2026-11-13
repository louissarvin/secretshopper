import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import DecryptedText from '@/components/elements/DecryptedText'
import { EmptyState, ErrorState, Skel } from '@/components/QueryState'
import TesterLine from '@/components/TesterLine'
import { useOwnerTests } from '@/hooks/useShop'
import { useNow } from '@/hooks/useMotion'
import { ago, clock, short } from '@/utils/near'
import { useActiveVault } from '@/hooks/useActiveVault'

export const Route = createFileRoute('/app/tests')({ component: Tests })

function Sealed({
  index,
  commitment,
  expiresAt,
  now,
}: {
  index: number
  commitment: string
  expiresAt: string
  now: number
}) {
  const [hover, setHover] = useState(0)
  const left = Date.parse(expiresAt) - now
  return (
    <div className="panel card" onPointerEnter={() => setHover((n) => n + 1)}>
      <div className="ptop">
        <span className="chip dash">Slot {index} · sealed</span>
      </div>
      <code
        className="mono dimt"
        style={{ fontSize: 12, overflowWrap: 'anywhere' }}
      >
        <DecryptedText text={commitment} duration={0.5} replayKey={hover} />
      </code>
      <div>
        <span className="label">
          {left > 0 ? 'opens in' : 'opened, waiting for reveal'}
        </span>
        <div className="cd num">
          {now
            ? left > 0
              ? clock(left)
              : ago(Date.parse(expiresAt), now)
            : '--:--:--'}
        </div>
      </div>
    </div>
  )
}

function Tests() {
  const vault = useActiveVault()
  const tests = useOwnerTests()
  const now = useNow()
  const items = tests.data?.items ?? []
  const sealed = items.filter((t) => !t.revealed)
  const revealed = items.filter((t) => t.revealed)

  return (
    <section className="view">
      <h1 className="disp vt">
        <span className="mline">
          <span>Tests</span>
        </span>
      </h1>
      <TesterLine vault={vault} />
      <div className="toolbar">
        <span className="label">
          Sealed until their timelock opens{' '}
          <span className="src">GET /tests</span>
        </span>
      </div>
      {tests.isError ? (
        <ErrorState
          what="tests"
          error={tests.error}
          retry={() => tests.refetch()}
        />
      ) : tests.isLoading ? (
        <Skel h={160} />
      ) : !sealed.length ? (
        <EmptyState title="No sealed tests">
          The tester commits a new batch on its schedule. Sealed slots show here
          with a countdown.
        </EmptyState>
      ) : (
        <div className="cards" data-stagger>
          {sealed.map((t) => (
            <Sealed
              key={t.slotIndex}
              index={t.slotIndex}
              commitment={t.commitment}
              expiresAt={t.expiresAt ?? new Date().toISOString()}
              now={now}
            />
          ))}
        </div>
      )}
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="ptop">
          <h3>Revealed</h3>
          <Link
            className="btn ghost sm"
            to="/s/$shopId"
            params={{ shopId: vault }}
          >
            Public view
          </Link>
        </div>
        <div className="tbox" style={{ marginTop: 8 }}>
          <table className="t">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Outcome</th>
                <th>Payee</th>
                <th>Revealed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {revealed.map((t) => (
                <tr key={t.slotIndex}>
                  <td className="m">#{t.slotIndex}</td>
                  <td>
                    <span className={`chip oc-${t.status}`}>{t.status}</span>
                  </td>
                  <td className="m">
                    {t.revealedPayee ? short(t.revealedPayee, 10, 6) : '–'}
                  </td>
                  <td className="m">
                    {t.revealedAt && now
                      ? ago(Date.parse(t.revealedAt), now)
                      : ''}
                  </td>
                  <td>
                    {t.status !== 'Void' && (
                      <Link
                        className="txl"
                        to="/s/$shopId/tests/$slot"
                        params={{
                          shopId: vault,
                          slot: String(t.slotIndex),
                        }}
                      >
                        Open
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
              {!tests.isLoading && !revealed.length && (
                <tr>
                  <td
                    colSpan={5}
                    className="m"
                    style={{ padding: '24px 12px' }}
                  >
                    Nothing revealed yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
