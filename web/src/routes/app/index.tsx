import { Link, createFileRoute } from '@tanstack/react-router'
import ActivityFeed from '@/components/ActivityFeed'
import { LedgerDownload } from '@/components/Downloads'
import ScheduleLine from '@/components/ScheduleLine'
import TwoSided from '@/components/TwoSided'
import VaultNear from '@/components/VaultNear'
import CountUp from '@/components/elements/CountUp'
import { EmptyState, ErrorState, Skel } from '@/components/QueryState'
import {
  useAccessKeys,
  useAlerts,
  useOwnerTests,
  usePolicy,
  useProposals,
  useRecentPayments,
  useScorecard,
  useStatus,
  useToken,
} from '@/hooks/useShop'
import { useNow } from '@/hooks/useMotion'
import { isVaultAgentScope, keyScope } from '@/lib/near/proofs'
import { nsToMs } from '@/lib/near/types'
import { ago, clock, fmtUnits, short, yoctoToNear } from '@/utils/near'
import { useActiveVault } from '@/hooks/useActiveVault'

export const Route = createFileRoute('/app/')({ component: Dashboard })

function Dashboard() {
  const shop = useActiveVault()
  const sc = useScorecard(shop)
  const status = useStatus(shop)
  const policy = usePolicy(shop)
  const keys = useAccessKeys(shop)
  const token = useToken(status.data?.token_id)
  const payments = useRecentPayments(shop, sc.data?.stats.payments)
  const tests = useOwnerTests()
  const alerts = useAlerts()
  const pending = useProposals('Pending')
  const now = useNow()

  const dec = token.data?.decimals ?? 6
  const sym = token.data?.symbol ?? ''
  const s = sc.data
  const p = policy.data
  const spent = s ? Number(BigInt(s.spent_24h)) : 0
  const cap = p ? Number(BigInt(p.daily_cap)) : 0
  const today = payments.data?.filter(
    (x) => now - nsToMs(x.at) < 86_400_000,
  ).length
  const agent = keys.data
    ?.map((k) => keyScope(k.access_key.permission))
    .find((x) => isVaultAgentScope(x, shop))
  const agentKey = keys.data?.find((k) =>
    isVaultAgentScope(keyScope(k.access_key.permission), shop),
  )
  const sealed =
    tests.data?.items.filter((t) => !t.revealed && t.expiresAt) ?? []
  const nextOpen = sealed.length
    ? Math.min(...sealed.map((t) => Date.parse(t.expiresAt!)))
    : null
  const cooldownEnd =
    status.data && p
      ? nsToMs(status.data.demoted_at) + nsToMs(p.rearm_cooldown)
      : 0
  const demoted = status.data?.mode === 'Demoted'

  return (
    <section className="view">
      <h1 className="disp vt">
        <span className="mline">
          <span>Dashboard</span>
        </span>
      </h1>

      {demoted && (
        <div className="alert">
          <div>
            <b>Your agent lost pay</b>
            <p>
              It paid a test, so every payment now needs your approval.{' '}
              {pending.data
                ? `${pending.data.items.length} proposals are waiting. `
                : ''}
              {now && now < cooldownEnd
                ? `Re-arming opens in ${clock(cooldownEnd - now)}.`
                : 'You can re-arm now.'}
            </p>
          </div>
          <div className="acts">
            <Link className="btn ink sm" to="/app/approvals">
              Review proposals
            </Link>
          </div>
        </div>
      )}
      {status.data?.mode === 'Frozen' && (
        <div className="alert">
          <div>
            <b>Agent frozen</b>
            <p>
              The agent key is deleted. Propose a new key in Approvals, then the
              vendor accepts it.
            </p>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 14, display: 'grid', gap: 8 }}>
        <TwoSided shopId={shop} />
        <ScheduleLine shopId={shop} />
      </div>
      {sc.isError ? (
        <ErrorState
          what="the scorecard"
          error={sc.error}
          retry={() => sc.refetch()}
        />
      ) : (
        <div className="kpis" data-stagger>
          <div className="panel kpi">
            <span className="label">
              Pass rate <span className="src">score_bps</span>
            </span>
            <span className="v num">
              {s ? (
                s.score_bps == null ? (
                  <small>No score yet</small>
                ) : (
                  <>
                    <CountUp to={s.score_bps / 100} decimals={2} />
                    <small>%</small>
                  </>
                )
              ) : (
                <Skel h={44} w={120} />
              )}
            </span>
            <p>
              {s
                ? `${s.stats.passed} passed, ${s.stats.failed} failed, ${s.stats.ignored} ignored`
                : ' '}
            </p>
          </div>
          <div className="panel kpi">
            <span className="label">
              Spent, 24 h <span className="src">spent_24h</span>
            </span>
            <span className="v num">
              {s ? fmtUnits(s.spent_24h, dec) : <Skel h={44} w={120} />}
              <small>
                {' '}
                / {p ? fmtUnits(p.daily_cap, dec) : '…'} {sym}
              </small>
            </span>
            <div className="meter">
              <i
                style={{
                  transform: `scaleX(${cap ? Math.min(1, spent / cap) : 0})`,
                }}
              />
            </div>
          </div>
          <div className="panel kpi">
            <span className="label">
              Payments today <span className="src">get_payments</span>
            </span>
            <span className="v num">
              {today ?? '–'}
              <small> / {p?.max_payments_per_day ?? '…'}</small>
            </span>
            <p>Rolling 24 h, settled and failed</p>
          </div>
          <div className="panel kpi">
            <span className="label">
              Sealed tests <span className="src">pending</span>
            </span>
            <span className="v num">
              {s ? <CountUp to={s.pending} /> : '–'}
            </span>
            <p>
              {nextOpen
                ? `Next opens ${ago(nextOpen, now || undefined)}`
                : s?.overdue_unrevealed
                  ? `${s.overdue_unrevealed} overdue for reveal`
                  : 'None waiting'}
            </p>
          </div>
        </div>
      )}

      <div className="cols">
        <div className="panel">
          <div className="ptop">
            <h3>Payments</h3>
            <span className="src">get_payments · RPC</span>
          </div>
          <div className="tbox" style={{ marginTop: 12 }}>
            {payments.isError ? (
              <ErrorState what="payments" error={payments.error} />
            ) : payments.data && !payments.data.length ? (
              <EmptyState title="No payments yet">
                Payments the agent or you make show up here.
              </EmptyState>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th className="hide-sm">Id</th>
                    <th>Payee</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th className="hide-sm">When</th>
                  </tr>
                </thead>
                <tbody>
                  {!payments.data &&
                    [0, 1, 2].map((i) => (
                      <tr key={i}>
                        <td colSpan={5}>
                          <Skel />
                        </td>
                      </tr>
                    ))}
                  {payments.data?.map((x) => (
                    <tr key={x.id}>
                      <td className="m hide-sm">#{x.id}</td>
                      <td className="m">{short(x.payee, 12, 10)}</td>
                      <td className="m">
                        {fmtUnits(x.amount, dec)} {sym}
                      </td>
                      <td>
                        <span
                          className={`chip${x.status === 'Failed' ? ' dash' : ''}`}
                        >
                          {x.status}
                          {x.by_owner ? ' · you' : ''}
                        </span>
                      </td>
                      <td className="m hide-sm">
                        {now ? ago(nsToMs(x.at), now) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div
          className="panel"
          style={{ display: 'grid', gap: 14, alignContent: 'start' }}
        >
          <div className="ptop">
            <h3>Agent key</h3>
            <span className="src">view_access_key_list</span>
          </div>
          {keys.isError ? (
            <ErrorState what="the key list" error={keys.error} />
          ) : !keys.data ? (
            <Skel h={100} />
          ) : agent?.kind === 'function' && agentKey ? (
            <>
              <div className="methods">
                {!agent.methods.includes('pay') && (
                  <span className="gone">pay</span>
                )}
                {agent.methods.map((m) => (
                  <span key={m} className={m === 'propose' ? 'on' : ''}>
                    {m}
                  </span>
                ))}
              </div>
              <dl className="kv">
                <dt>key</dt>
                <dd>{short(agentKey.public_key, 14, 6)}</dd>
                <dt>kind</dt>
                <dd>
                  {agent.gasKey
                    ? `gas key, ${agent.lanes ?? '?'} lanes`
                    : 'function call'}
                </dd>
                {agent.balance && p && (
                  <>
                    <dt>gas balance</dt>
                    <dd>
                      {yoctoToNear(agent.balance)} of{' '}
                      {yoctoToNear(p.key_allowance, 2)} NEAR
                    </dd>
                  </>
                )}
                <dt>full-access</dt>
                <dd>
                  {
                    keys.data.filter(
                      (k) => keyScope(k.access_key.permission).kind === 'full',
                    ).length
                  }{' '}
                  on the vault
                </dd>
              </dl>
            </>
          ) : (
            <EmptyState title="No agent key">
              {status.data?.pending_key
                ? 'A key is proposed and waiting for the vendor to accept it.'
                : 'Propose a key in Approvals to arm the agent.'}
            </EmptyState>
          )}
        </div>
      </div>
      <div
        className="panel"
        style={{ marginTop: 12, display: 'grid', gap: 12 }}
      >
        <div className="ptop">
          <h3>Vault NEAR</h3>
          <span className="src">gas, storage and reveals</span>
        </div>
        <VaultNear vault={shop} />
      </div>
      <div style={{ marginTop: 12 }}>
        <ActivityFeed
          q={alerts}
          title="Activity"
          src="GET /company/alerts"
          empty="Demotions, failed tests, new proposals and re-arming show up here."
        />
      </div>
      <div
        className="panel"
        style={{ marginTop: 12, display: 'grid', gap: 12 }}
      >
        <h3>Ledger for your accountant</h3>
        <LedgerDownload shopId={shop} />
      </div>
    </section>
  )
}
