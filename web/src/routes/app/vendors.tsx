import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApprovedPayee } from '@/lib/near/types'
import type { Vendor } from '@/lib/api/shop'
import { EmptyState, ErrorState, Skel } from '@/components/QueryState'
import { useFeedback } from '@/components/Feedback'
import {
  useBlocklistOf,
  usePayees,
  usePolicy,
  useVendors,
} from '@/hooks/useShop'
import { useNow } from '@/hooks/useMotion'
import { ownerApi } from '@/lib/api/shop'
import { ONE_YOCTO } from '@/lib/near/wallet'
import { nsToMs } from '@/lib/near/types'
import { ago, isAccountId } from '@/utils/near'
import { config } from '@/config'
import { useActiveVault } from '@/hooks/useActiveVault'

export const Route = createFileRoute('/app/vendors')({ component: Vendors })

function payeeState(p: ApprovedPayee, now: number): [string, string] {
  const a = nsToMs(p.active_at)
  const r = p.removed_at ? nsToMs(p.removed_at) : null
  if (r && now >= r) return ['Removed', 'dash']
  if (r) return [`Removing ${ago(r, now)}`, 'dash']
  if (now < a) return [`Active ${ago(a, now)}`, 'dash']
  return ['Active', '']
}

/** A sample invoice pasted as JSON: one object of at most 16 KB, as the API accepts. */
function parseSample(text: string): Record<string, unknown> | string {
  if (new TextEncoder().encode(text).length > 16 * 1024)
    return 'The sample is over 16 KB.'
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : 'Paste one invoice as a JSON object.'
  } catch {
    return 'The sample is not valid JSON.'
  }
}

const SAMPLE_HINT =
  'Paste one of their invoices as JSON. Write <account> where the payee account goes and <company> for your company. New invoices in the inbox copy this layout, and the tester writes lures in it.'

function AddVendor() {
  const qc = useQueryClient()
  const { toast } = useFeedback()
  const [f, setF] = useState({ name: '', email: '', payee: '', sample: '' })
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs = []
    if (!f.name.trim()) errs.push('Add the legal name.')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()))
      errs.push('Contact email does not look like an email address.')
    if (f.payee && !isAccountId(f.payee.trim()))
      errs.push('Payee must be a NEAR account id.')
    const sample = f.sample.trim() ? parseSample(f.sample.trim()) : null
    if (typeof sample === 'string') errs.push(sample)
    if (errs.length) return setErr(errs.join(' '))
    setErr(null)
    try {
      await ownerApi.addVendor({
        legalName: f.name.trim(),
        contactEmail: f.email.trim(),
        approvedPayees: f.payee
          ? [{ account: f.payee.trim(), rail: 'Near' }]
          : [],
        sampleInvoices: sample && typeof sample === 'object' ? [sample] : [],
      })
      await qc.invalidateQueries({ queryKey: ['owner', 'vendors'] })
      setF({ name: '', email: '', payee: '', sample: '' })
      toast(
        'Vendor saved. Add its payee on chain below so the vault trusts it.',
      )
    } catch (e2) {
      setErr(
        e2 instanceof Error ? e2.message : 'The API did not accept the vendor.',
      )
    }
  }
  return (
    <form
      className="panel formgrid"
      onSubmit={submit}
      noValidate
      style={{ marginTop: 12 }}
    >
      <h3 className="full">Add a vendor</h3>
      <div className="field">
        <label htmlFor="vn">Legal name</label>
        <input
          id="vn"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          maxLength={200}
        />
      </div>
      <div className="field">
        <label htmlFor="ve">Contact email</label>
        <input
          id="ve"
          type="email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
          maxLength={254}
        />
      </div>
      <div className="field full">
        <label htmlFor="vp">Payee account (optional)</label>
        <input
          id="vp"
          placeholder="vendor.near"
          autoComplete="off"
          spellCheck={false}
          value={f.payee}
          onChange={(e) => setF({ ...f, payee: e.target.value })}
        />
        <small>
          Saved as a note in the API. Only the on-chain list below lets the
          agent pay it.
        </small>
      </div>
      <div className="field full">
        <label htmlFor="vs">Sample invoice, JSON (optional)</label>
        <textarea
          id="vs"
          rows={5}
          spellCheck={false}
          value={f.sample}
          onChange={(e) => setF({ ...f, sample: e.target.value })}
          placeholder='{ "number": "INV-001", "total": "1.20", "pay_to": "<account>", "bill_to": "<company>" }'
        />
        <small>{SAMPLE_HINT}</small>
      </div>
      {err && <small className="sheet-err full">{err}</small>}
      <div className="full">
        <button className="btn solid magnet" type="submit">
          Save vendor
        </button>
      </div>
    </form>
  )
}

/** Adds a sample invoice to an existing vendor through PUT /vendors/:id (at most 5 kept). */
function AddSample({ v }: { v: Vendor }) {
  const qc = useQueryClient()
  const { toast } = useFeedback()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  if (v.sampleInvoices.length >= 5)
    return <small className="dimt">5 samples, the most the API keeps.</small>
  if (!open)
    return (
      <button
        className="btn ghost sm"
        type="button"
        onClick={() => setOpen(true)}
        style={{ justifySelf: 'start' }}
      >
        Add a sample invoice
      </button>
    )
  const save = async () => {
    const sample = parseSample(text.trim())
    if (typeof sample === 'string') return setErr(sample)
    setErr(null)
    try {
      await ownerApi.updateVendor(v.id, {
        sampleInvoices: [...(v.sampleInvoices as Array<object>), sample],
      })
      await qc.invalidateQueries({ queryKey: ['owner', 'vendors'] })
      setText('')
      setOpen(false)
      toast(`Sample saved for ${v.legalName}.`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The API did not accept it.')
    }
  }
  return (
    <div className="field">
      <label htmlFor={`smp-${v.id}`}>Sample invoice, JSON</label>
      <textarea
        id={`smp-${v.id}`}
        rows={5}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <small>{SAMPLE_HINT}</small>
      {err && <small className="sheet-err">{err}</small>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn solid sm" type="button" onClick={save}>
          Save sample
        </button>
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Marks a payee that the shared blocklist proves was a lure payee. */
function BlockedChip({ account }: { account: string }) {
  const r = useBlocklistOf(account)
  return r.data?.listed ? (
    <span className="chip solid" title={r.data.entries[0]?.reason}>
      blocklisted
    </span>
  ) : null
}

const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

/** Owner report to the shared blocklist; the API accepts it only with a tx proving a lure payee on this vault. */
function ReportPayee() {
  const qc = useQueryClient()
  const { toast } = useFeedback()
  const [f, setF] = useState({ accountId: '', reason: '', evidenceTx: '' })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set =
    (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setF((v) => ({ ...v, [k]: e.target.value }))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const a = f.accountId.trim()
    const r = f.reason.trim()
    const t = f.evidenceTx.trim()
    if (!isAccountId(a)) return setErr('Enter the payee NEAR account.')
    if (!r || r.length > 280 || [...r].some((ch) => ch.charCodeAt(0) < 32))
      return setErr('Give a reason of 1 to 280 characters on one line.')
    if (!TX_RE.test(t))
      return setErr('Enter the transaction hash that proves it, base58.')
    setErr(null)
    setBusy(true)
    try {
      const res = await ownerApi.reportPayee({
        accountId: a,
        reason: r,
        evidenceTx: t,
      })
      await qc.invalidateQueries({ queryKey: ['api', 'blocklist'] })
      toast(
        res.created
          ? `${a} is on the shared blocklist.`
          : `${a} was already listed with this transaction.`,
      )
      setF({ accountId: '', reason: '', evidenceTx: '' })
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'The report was refused.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="panel"
      onSubmit={submit}
      noValidate
      style={{ marginTop: 12, display: 'grid', gap: 12 }}
    >
      <div className="ptop">
        <h3>Report a payee</h3>
        <span className="src">POST /blocklist</span>
      </div>
      <p className="dimt" style={{ fontSize: 14 }}>
        Add a lure payee to the blocklist every vault shares. The API checks the
        transaction on chain first: it must show this account was a lure payee
        on your vault, for example the reveal of a failed test.
      </p>
      <div className="formgrid">
        <div className="field">
          <label htmlFor="rp-a">Payee account</label>
          <input
            id="rp-a"
            value={f.accountId}
            onChange={set('accountId')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label htmlFor="rp-t">Proof transaction</label>
          <input
            id="rp-t"
            value={f.evidenceTx}
            onChange={set('evidenceTx')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="field full">
          <label htmlFor="rp-r">Reason</label>
          <input
            id="rp-r"
            value={f.reason}
            onChange={set('reason')}
            maxLength={280}
          />
        </div>
      </div>
      {err && (
        <small className="sheet-err" role="alert">
          {err}
        </small>
      )}
      <div>
        <button className="btn solid sm" type="submit" disabled={busy}>
          {busy ? 'Checking on chain…' : 'Report payee'}
        </button>
      </div>
    </form>
  )
}

function Vendors() {
  const vault = useActiveVault()
  const vendors = useVendors()
  const payees = usePayees(vault)
  const policy = usePolicy(vault)
  const { confirmCall } = useFeedback()
  const now = useNow(30_000)
  const [acct, setAcct] = useState('')
  const [label, setLabel] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const delayH = policy.data
    ? Math.round(nsToMs(policy.data.payee_delay) / 3_600_000)
    : null

  const add = () => {
    if (!isAccountId(acct.trim()))
      return setErr('Enter a valid NEAR account id.')
    const bytes = new TextEncoder().encode(label.trim()).length
    if (!bytes || bytes > 64) return setErr('Add a label of at most 64 bytes.')
    setErr(null)
    confirmCall({
      receiverId: vault,
      title: 'Add payee',
      method: 'add_payee',
      args: { account_id: acct.trim(), label: label.trim() },
      deposit: ONE_YOCTO,
      tgas: config.gasTgas.default,
      note: `The payee becomes active after ${delayH ?? 'the'} hour delay (payee_delay).`,
    }).then((ok) => ok && (setAcct(''), setLabel('')))
  }

  return (
    <section className="view">
      <h1 className="disp vt">
        <span className="mline">
          <span>Vendors</span>
        </span>
      </h1>
      {vendors.isError ? (
        <ErrorState
          what="vendors"
          error={vendors.error}
          retry={() => vendors.refetch()}
        />
      ) : vendors.isLoading ? (
        <Skel h={140} />
      ) : !vendors.data?.items.length ? (
        <EmptyState title="No vendors yet">
          Add the suppliers your agent pays. The tester uses their style to
          write lures.
        </EmptyState>
      ) : (
        <div className="cards" data-stagger>
          {vendors.data.items.map((v) => (
            <div className="panel card" key={v.id}>
              <div className="ptop">
                <h3>{v.legalName}</h3>
                <span className="chip">
                  {v.approvedPayees.length} payee
                  {v.approvedPayees.length === 1 ? '' : 's'}
                </span>
              </div>
              <dl className="kv">
                <dt>contact</dt>
                <dd>{v.contactEmail}</dd>
                {v.approvedPayees.map((p) => (
                  <div key={p.account} style={{ display: 'contents' }}>
                    <dt>{p.rail}</dt>
                    <dd>{p.account}</dd>
                  </div>
                ))}
              </dl>
              <span className="dimt" style={{ fontSize: 13 }}>
                {v.sampleInvoices.length
                  ? `${v.sampleInvoices.length} sample invoice${v.sampleInvoices.length === 1 ? '' : 's'}`
                  : 'No sample invoice yet: add one so inbox invoices and lures follow its layout.'}
              </span>
              <AddSample v={v} />
              <span className="src">
                GET /vendors · advisory, chain is the authority
              </span>
            </div>
          ))}
        </div>
      )}
      <AddVendor />

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="ptop">
          <h3>Approved payees on chain</h3>
          <span className="src">get_payees · RPC</span>
        </div>
        <p className="dimt" style={{ fontSize: 14, marginTop: 6 }}>
          The vault only trusts this list. Changes take effect after{' '}
          {delayH ?? 'a'} hour{delayH === 1 ? '' : 's'}, so nobody can add a
          payee and pay it in the same minute.
        </p>
        {payees.isError ? (
          <ErrorState what="payees" error={payees.error} />
        ) : (
          <div className="tbox" style={{ marginTop: 10 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Label</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {!payees.data && (
                  <tr>
                    <td colSpan={4}>
                      <Skel />
                    </td>
                  </tr>
                )}
                {payees.data?.map((p) => {
                  const [t, c] = now ? payeeState(p, now) : ['…', '']
                  return (
                    <tr key={p.account_id}>
                      <td className="m">{p.account_id}</td>
                      <td>{p.label}</td>
                      <td>
                        <span className={`chip ${c}`}>{t}</span>{' '}
                        <BlockedChip account={p.account_id} />
                      </td>
                      <td>
                        {!p.removed_at && (
                          <button
                            className="btn ghost sm"
                            type="button"
                            onClick={() =>
                              confirmCall({
                                receiverId: vault,
                                title: 'Remove payee',
                                method: 'remove_payee',
                                args: { account_id: p.account_id },
                                deposit: ONE_YOCTO,
                                tgas: config.gasTgas.default,
                                note: `Takes effect after ${delayH ?? 'the'} hour delay.`,
                              })
                            }
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {payees.data && !payees.data.length && (
                  <tr>
                    <td
                      colSpan={4}
                      className="m"
                      style={{ padding: '24px 12px' }}
                    >
                      No approved payees yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="formgrid" style={{ marginTop: 16 }}>
          <div className="field">
            <label htmlFor="npa">Payee account</label>
            <input
              id="npa"
              placeholder="vendor.near"
              autoComplete="off"
              spellCheck={false}
              value={acct}
              onChange={(e) => setAcct(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="npl">Label</label>
            <input
              id="npl"
              placeholder="Vendor name"
              maxLength={64}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          {err && <small className="sheet-err full">{err}</small>}
        </div>
        <button
          className="btn solid magnet"
          type="button"
          style={{ marginTop: 12 }}
          onClick={add}
        >
          Add payee
        </button>
      </div>
      <ReportPayee />
    </section>
  )
}
