import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { Proposal } from '@/lib/near/types'
import { EmptyState, ErrorState, Skel } from '@/components/QueryState'
import { useFeedback } from '@/components/Feedback'
import {
  usePayees,
  usePendingLimits,
  usePolicy,
  useProposals,
  useStatus,
  useToken,
} from '@/hooks/useShop'
import { useNow } from '@/hooks/useMotion'
import { ONE_YOCTO } from '@/lib/near/wallet'
import { nsToMs } from '@/lib/near/types'
import { view } from '@/lib/near/rpc'
import {
  ED25519_RE,
  ago,
  clock,
  fmtUnits,
  parseUnits,
  short,
  utcStamp,
} from '@/utils/near'
import { config } from '@/config'
import { useActiveVault } from '@/hooks/useActiveVault'

export const Route = createFileRoute('/app/approvals')({ component: Approvals })

function Proposals({ dec, sym }: { dec: number; sym: string }) {
  const vault = useActiveVault()
  const pending = useProposals('Pending')
  const payees = usePayees(vault)
  const { confirmCall } = useFeedback()
  const now = useNow(30_000)
  // The signed call carries only the id, so what the owner sees must come from the chain (WYSIWYS)
  const [onChain, setOnChain] = useState<
    Partial<Record<number, Proposal | null>>
  >({})
  const approved = new Set(
    payees.data?.filter((p) => !p.removed_at).map((p) => p.account_id),
  )

  useEffect(() => {
    for (const p of pending.data?.items ?? [])
      if (!(p.proposalId in onChain))
        view<Array<Proposal>>(
          'get_proposals',
          { from: p.proposalId, limit: 1 },
          vault,
        ).then(
          (r) => setOnChain((m) => ({ ...m, [p.proposalId]: r[0] ?? null })),
          () => setOnChain((m) => ({ ...m, [p.proposalId]: null })),
        )
  }, [pending.data, onChain])

  if (pending.isError)
    return (
      <ErrorState
        what="proposals"
        error={pending.error}
        retry={() => pending.refetch()}
      />
    )
  if (pending.isLoading) return <Skel h={180} />
  if (!pending.data?.items.length)
    return (
      <EmptyState title="Nothing waiting">
        When the agent is demoted it proposes payments instead of paying. They
        show up here for you to approve.
      </EmptyState>
    )

  return (
    <div className="cards">
      {pending.data.items.map((p) => {
        const c = onChain[p.proposalId]
        // The rail decides the gas: Intents pays through ft_transfer_call
        const rail = c?.rail
        const differs =
          !!c &&
          (c.amount !== p.amount ||
            c.payee !== p.payee ||
            c.invoice_id !== p.invoiceId ||
            c.status !== 'Pending')
        const act = async (approve: boolean) => {
          if (approve && (!c || differs)) return
          await confirmCall({
            receiverId: vault,
            title: `${approve ? 'Approve' : 'Reject'} proposal #${p.proposalId}`,
            method: approve ? 'approve' : 'reject',
            args: { proposal_id: p.proposalId },
            deposit: ONE_YOCTO,
            tgas: approve
              ? rail === 'Intents'
                ? config.gasTgas.approveIntents
                : config.gasTgas.approveNear
              : config.gasTgas.default,
            note: approve
              ? `Pays ${fmtUnits(c!.amount, dec)} ${sym} to ${c!.payee}, read from the vault. Your approval can exceed the agent's cap.`
              : 'Nothing is paid. The agent sees the proposal as rejected.',
          })
        }
        return (
          <div className="panel card" key={p.proposalId}>
            <div className="ptop">
              <span className="chip solid">Proposal #{p.proposalId}</span>
              <span className="label">
                {now ? ago(Date.parse(p.createdAt), now) : ''}
              </span>
            </div>
            <div>
              <span className="amt num">
                {c ? fmtUnits(c.amount, dec) : '…'}
              </span>{' '}
              <span className="mono dimt">{sym}</span>
            </div>
            {differs && (
              <p className="sheet-err" role="alert">
                The API's copy of this proposal does not match the vault, or it
                is no longer pending. Approve is off; the figures shown are the
                vault's.
              </p>
            )}
            {c === null && (
              <p className="sheet-err" role="alert">
                The vault has no such proposal. Approve is off.
              </p>
            )}
            <dl className="kv">
              <dt>payee</dt>
              <dd>{c ? short(c.payee, 16, 14) : '…'}</dd>
              <dt>on chain</dt>
              <dd>
                {payees.data && c
                  ? approved.has(c.payee)
                    ? 'approved payee'
                    : 'not an approved payee'
                  : '…'}
              </dd>
              <dt>rail</dt>
              <dd>{rail ?? '…'}</dd>
              <dt>invoice</dt>
              <dd>{c ? short(c.invoice_id, 10, 6) : '…'}</dd>
            </dl>
            <div className="acts">
              <button
                className="btn solid sm magnet"
                type="button"
                onClick={() => act(true)}
                disabled={!c || differs}
              >
                Approve and pay
              </button>
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => act(false)}
              >
                Reject
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Rearm() {
  const vault = useActiveVault()
  const status = useStatus(vault)
  const policy = usePolicy(vault)
  const { confirmCall } = useFeedback()
  const now = useNow()
  const [pk, setPk] = useState('')
  if (status.isError)
    return <ErrorState what="the vault status" error={status.error} />
  if (!status.data || !policy.data) return <Skel h={120} />
  const s = status.data
  const coolEnd = nsToMs(s.demoted_at) + nsToMs(policy.data.rearm_cooldown)
  const coolDone = s.mode !== 'Demoted' || now >= coolEnd
  const armed = s.mode === 'Armed'
  const valid = ED25519_RE.test(pk.trim())
  const steps: Array<[string, string, boolean]> = [
    [
      'Cooldown',
      s.mode !== 'Demoted'
        ? 'Not needed'
        : coolDone
          ? 'Done'
          : now
            ? `Opens in ${clock(coolEnd - now)}`
            : '…',
      !coolDone,
    ],
    [
      'You propose a key',
      s.pending_key
        ? `Proposed ${short(s.pending_key, 12, 6)}`
        : 'propose_key, 1 yoctoNEAR',
      coolDone && !s.pending_key && !armed,
    ],
    ['Vendor accepts', `accept_key by ${s.vendor_id}`, !!s.pending_key],
    ['Armed', 'pay, decline, ack', armed],
  ]
  return (
    <div className="panel" style={{ marginTop: 12, display: 'grid', gap: 18 }}>
      <div className="ptop">
        <h3>Re-arm the agent</h3>
        <span className="src">get_status · rearm_cooldown</span>
      </div>
      <div className="steps">
        {steps.map(([b, t, on], i) => (
          <div key={b} className={on ? 'now' : ''}>
            <span className="label" style={{ color: 'inherit', opacity: 0.7 }}>
              0{i + 1}
            </span>
            <b>{b}</b>
            <span>{t}</span>
          </div>
        ))}
      </div>
      {armed ? (
        <p className="dimt" style={{ fontSize: 14 }}>
          The agent is armed. Proposing a key is only allowed after a demotion
          or a freeze.
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="pk">New agent public key</label>
            <input
              id="pk"
              placeholder="ed25519:…"
              autoComplete="off"
              spellCheck={false}
              value={pk}
              onChange={(e) => setPk(e.target.value)}
            />
            <small className={pk && !valid ? 'err' : ''}>
              {pk && !valid ? (
                'Use ed25519: followed by 43 or 44 base58 characters.'
              ) : (
                <>
                  The vendor accepts the same key in the{' '}
                  <Link className="txl" to="/vendor">
                    vendor console
                  </Link>{' '}
                  before the agent can pay again.
                </>
              )}
            </small>
          </div>
          <div>
            <button
              className="btn solid magnet"
              type="button"
              disabled={!coolDone || !valid}
              onClick={() =>
                confirmCall({
                  receiverId: vault,
                  title: 'Propose agent key',
                  method: 'propose_key',
                  args: { public_key: pk.trim() },
                  deposit: ONE_YOCTO,
                  tgas: config.gasTgas.default,
                  note: 'The vendor then calls accept_key with the same key.',
                }).then((ok) => ok && setPk(''))
              }
            >
              Propose key
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function LimitsPanel({ dec, sym }: { dec: number; sym: string }) {
  const vault = useActiveVault()
  const policy = usePolicy(vault)
  const pendingLimits = usePendingLimits(vault)
  const { confirmCall } = useFeedback()
  const now = useNow(30_000)
  const p = policy.data
  const [v, setV] = useState<{
    daily: string
    per: string
    payees: string
  } | null>(null)
  useEffect(() => {
    if (p && !v)
      setV({
        daily: fmtUnits(p.daily_cap, dec, 2).replace(/,/g, ''),
        per: fmtUnits(p.max_per_payment, dec, 2).replace(/,/g, ''),
        payees: String(p.max_new_payees_per_day),
      })
  }, [p, v, dec])
  if (policy.isError)
    return <ErrorState what="the policy" error={policy.error} />
  if (!p || !v) return <Skel h={140} />
  const rows: Array<[keyof typeof v, string, string | null, bigint]> = [
    [
      'daily',
      `Daily cap, ${sym}`,
      parseUnits(v.daily, dec),
      BigInt(p.daily_cap),
    ],
    [
      'per',
      `Max per payment, ${sym}`,
      parseUnits(v.per, dec),
      BigInt(p.max_per_payment),
    ],
    [
      'payees',
      'New payees per day',
      /^\d{1,9}$/.test(v.payees) ? v.payees : null,
      BigInt(p.max_new_payees_per_day),
    ],
  ]
  const when = (next: string | null, cur: bigint) =>
    next === null
      ? ['enter a valid number', '']
      : BigInt(next) === cur
        ? ['current', '']
        : BigInt(next) < cur
          ? ['tighter, applies now', 'now']
          : [
              `looser, applies in ${Math.round(nsToMs(p.limits_delay) / 3_600_000)} h`,
              'wait',
            ]
  const ok = rows.every(([, , n]) => n !== null)
  const pl = pendingLimits.data
  return (
    <div className="panel" style={{ marginTop: 12, display: 'grid', gap: 16 }}>
      <div className="ptop">
        <h3>Limits</h3>
        <span className="src">get_policy · set_limits</span>
      </div>
      <p className="dimt" style={{ fontSize: 14 }}>
        Tighter limits apply now. Looser limits wait, so nobody can quietly
        raise them right before a payment.
      </p>
      {pl && (
        <div className="state">
          <b>Queued change</b>
          <p>
            Daily cap {fmtUnits(pl.limits.daily_cap, dec)}, max per payment{' '}
            {fmtUnits(pl.limits.max_per_payment, dec)},{' '}
            {pl.limits.max_new_payees_per_day} new payees a day.{' '}
            {now >= nsToMs(pl.effective_at)
              ? 'Ready to apply.'
              : `Applies ${utcStamp(nsToMs(pl.effective_at))}.`}
          </p>
          {now >= nsToMs(pl.effective_at) && (
            <button
              className="btn ghost sm"
              type="button"
              onClick={() =>
                confirmCall({
                  receiverId: vault,
                  title: 'Apply queued limits',
                  method: 'apply_limits',
                  args: {},
                  deposit: '0',
                  tgas: config.gasTgas.default,
                })
              }
            >
              Apply now
            </button>
          )}
        </div>
      )}
      <div className="limits">
        {rows.map(([k, label, next, cur]) => {
          const [t, c] = when(next, cur)
          return (
            <div className="field lim" key={k}>
              <label htmlFor={`l-${k}`}>{label}</label>
              <input
                id={`l-${k}`}
                inputMode="decimal"
                value={v[k]}
                onChange={(e) => setV({ ...v, [k]: e.target.value })}
              />
              <small className={`when ${c}`}>{t}</small>
            </div>
          )
        })}
      </div>
      <div>
        <button
          className="btn ghost"
          type="button"
          disabled={!ok}
          onClick={() =>
            confirmCall({
              receiverId: vault,
              title: 'Save limits',
              method: 'set_limits',
              args: {
                daily_cap: rows[0][2]!,
                max_per_payment: rows[1][2]!,
                max_new_payees_per_day: Number(rows[2][2]),
              },
              deposit: ONE_YOCTO,
              tgas: config.gasTgas.default,
              note: 'Looser fields queue; anyone can apply them after the delay with apply_limits.',
            })
          }
        >
          Save limits
        </button>
      </div>
    </div>
  )
}

function Freeze() {
  const vault = useActiveVault()
  const status = useStatus(vault)
  const { confirmCall } = useFeedback()
  const [text, setText] = useState('')
  const phrase = `freeze ${vault.split('.')[0]}`
  if (status.data?.mode === 'Frozen' || status.data?.mode === 'Unarmed')
    return null
  return (
    <div
      className="panel danger"
      style={{ marginTop: 12, display: 'grid', gap: 14 }}
    >
      <div className="ptop">
        <h3>Freeze the agent</h3>
        <span className="src">freeze()</span>
      </div>
      <p className="dimt" style={{ fontSize: 14 }}>
        Deletes the agent key at once and burns its unspent gas balance. Nothing
        can be paid or proposed until you and the vendor arm a new key. To
        confirm, type{' '}
        <b className="mono" style={{ color: 'var(--paper)' }}>
          {phrase}
        </b>
        .
      </p>
      <div className="formgrid">
        <div className="field">
          <label htmlFor="fz">Confirmation</label>
          <input
            id="fz"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div style={{ alignSelf: 'end' }}>
          <button
            className="btn solid"
            type="button"
            disabled={text.trim() !== phrase}
            onClick={() =>
              confirmCall({
                receiverId: vault,
                title: 'Freeze the agent',
                method: 'freeze',
                args: {},
                deposit: ONE_YOCTO,
                tgas: config.gasTgas.keyChange,
                note: 'The agent key is deleted in this transaction.',
              }).then((ok) => ok && setText(''))
            }
          >
            Freeze agent
          </button>
        </div>
      </div>
    </div>
  )
}

function Approvals() {
  const vault = useActiveVault()
  const status = useStatus(vault)
  const token = useToken(status.data?.token_id)
  // Amounts are shown and converted with the token's own decimals only: never a guess
  const dec = token.data?.decimals
  const sym = token.data?.symbol ?? ''
  return (
    <section className="view">
      <h1 className="disp vt">
        <span className="mline">
          <span>Approvals</span>
        </span>
      </h1>
      <div className="toolbar">
        <span className="label">
          Waiting for you{' '}
          <span className="src">GET /proposals?status=Pending</span>
        </span>
      </div>
      {dec === undefined ? (
        token.isError ? (
          <ErrorState what="the token" error={token.error} />
        ) : (
          <Skel h={160} />
        )
      ) : (
        <Proposals dec={dec} sym={sym} />
      )}
      <Rearm />
      {dec !== undefined && <LimitsPanel dec={dec} sym={sym} />}
      <Freeze />
    </section>
  )
}
