import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { InvoiceItem } from '@/lib/api/shop'
import { EmptyState, ErrorState, Skel } from '@/components/QueryState'
import { useFeedback } from '@/components/Feedback'
import {
  useCompany,
  useInvoices,
  useProposals,
  useStatus,
  useToken,
  useVendors,
} from '@/hooks/useShop'
import { useNow } from '@/hooks/useMotion'
import { ownerApi } from '@/lib/api/shop'
import { invoiceIdOf } from '@/lib/near/proofs'
import { buildInvoice, isTemplate, layoutOf, payeesOf } from '@/lib/invoice'
import { nsToMs } from '@/lib/near/types'
import { ago, short, utcStamp } from '@/utils/near'
import { useActiveVault } from '@/hooks/useActiveVault'

export const Route = createFileRoute('/app/inbox')({ component: Inbox })

const FILTERS: Record<string, (i: InvoiceItem) => boolean> = {
  All: () => true,
  Waiting: (i) => !i.decision,
  Paid: (i) => i.decision?.kind === 'Paid',
  Proposed: (i) => i.decision?.kind === 'Proposed',
  Declined: (i) => i.decision?.kind === 'Declined',
}

function Drawer({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <>
      <div className="scrim on" onClick={onClose} />
      <aside className="drawer on" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="x" type="button" onClick={onClose} autoFocus>
            Close
          </button>
        </header>
        <div style={{ display: 'grid', gap: 16 }}>{children}</div>
      </aside>
    </>
  )
}

function AddInvoice({ onClose }: { onClose: () => void }) {
  const vault = useActiveVault()
  const vendors = useVendors()
  const company = useCompany()
  const status = useStatus(vault)
  const token = useToken(status.data?.token_id)
  const sym = token.data?.symbol ?? 'token'
  const qc = useQueryClient()
  const { toast } = useFeedback()
  const [f, setF] = useState({
    vendorId: '',
    payee: '',
    number: '',
    total: '',
    description: '',
    due: '',
    fromName: '',
    fromEmail: '',
    subject: '',
    body: '',
  })
  const [id, setId] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set =
    (k: keyof typeof f) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) =>
      setF((v) => ({ ...v, [k]: e.target.value }))
  const vendor =
    vendors.data?.items.find((v) => v.id === f.vendorId) ??
    vendors.data?.items[0]
  const vendorId = vendor?.id ?? ''
  // The vendor's latest sample sets the layout; the agent compares new invoices with it.
  const sample = vendor?.sampleInvoices.at(-1)
  const template = isTemplate(sample) ? sample : undefined
  const layout = template ? layoutOf(template) : null
  const payee = f.payee || vendor?.approvedPayees[0]?.account || ''
  const fromName = f.fromName || vendor?.legalName || ''
  const fromEmail = f.fromEmail || vendor?.contactEmail || ''
  const doc = useMemo(
    () =>
      template
        ? buildInvoice(template, {
            number: f.number.trim(),
            total: f.total.trim(),
            description: f.description.trim(),
            due: f.due,
            payee,
            billTo: company.data?.name ?? '',
            today: new Date().toISOString().slice(0, 10),
          })
        : null,
    [template, f, payee, company.data?.name],
  )

  // The API adds vendor_id before hashing, so the preview does too.
  useEffect(() => {
    if (doc) invoiceIdOf({ ...doc, vendor_id: vendorId }).then(setId)
  }, [doc, vendorId])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs = []
    if (!vendorId) errs.push('Add a vendor first.')
    if (!doc)
      errs.push('This vendor has no sample invoice to copy the layout from.')
    if (!payee) errs.push('This vendor has no payee account.')
    if (!f.number.trim()) errs.push('Add an invoice number.')
    if (!/^\d+(\.\d{1,6})?$/.test(f.total.trim()) || Number(f.total) <= 0)
      errs.push('Total needs to be a positive number with at most 6 decimals.')
    if (layout?.hasDescription && !f.description.trim())
      errs.push('Say what the invoice is for.')
    if (layout?.hasDue && !f.due) errs.push('Pick a due date.')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail.trim()))
      errs.push('From email does not look like an email address.')
    if (!fromName.trim()) errs.push('Add the sender name.')
    // A sample with its own payee would send money elsewhere than the form shows
    if (doc && !payeesOf(doc).every((x) => x === payee))
      errs.push(
        `The vendor's sample names another payee than ${payee}. Fix the sample in Vendors.`,
      )
    if (doc && !payeesOf(doc).length)
      errs.push("The vendor's sample has no payee field to fill.")
    if (errs.length || !doc) return setErr(errs.join(' '))
    setErr(null)
    setBusy(true)
    try {
      const r = await ownerApi.addInvoice({
        vendorId,
        document: doc,
        email: {
          from_name: fromName.trim(),
          from_email: fromEmail.trim(),
          subject: f.subject || `Invoice ${f.number.trim()}`,
          body: f.body,
        },
      })
      await qc.invalidateQueries({ queryKey: ['owner', 'invoices'] })
      toast(
        r.invoiceId === id
          ? `Queued for the ${utcStamp(Date.parse(r.deliverAt))} tick.`
          : `Queued, but the API's invoice id ${r.invoiceId.slice(0, 10)}… differs from the one computed here. Check the inbox.`,
      )
      onClose()
    } catch (e2) {
      setErr(
        e2 instanceof Error
          ? e2.message
          : 'The API did not accept the invoice.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (vendors.data && !vendors.data.items.length)
    return (
      <EmptyState title="No vendors yet">
        Add a vendor in Vendors, then come back to add its invoices.
      </EmptyState>
    )
  return (
    <form className="formgrid" onSubmit={submit} noValidate>
      <p className="dimt full" style={{ fontSize: 14 }}>
        The agent receives it on the next release tick, mixed in with everything
        else.
      </p>
      <div className="field full">
        <label htmlFor="fv">Vendor</label>
        <select
          id="fv"
          value={vendorId}
          onChange={(e) =>
            setF((v) => ({
              ...v,
              vendorId: e.target.value,
              payee: '',
              fromName: '',
              fromEmail: '',
            }))
          }
        >
          {vendors.data?.items.map((v) => (
            <option key={v.id} value={v.id}>
              {v.legalName}
            </option>
          ))}
        </select>
      </div>
      <div className="field full">
        <label htmlFor="fp">Pay to</label>
        <select id="fp" value={payee} onChange={set('payee')}>
          {vendor?.approvedPayees.map((p) => (
            <option key={p.account} value={p.account}>
              {p.account}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="fn">Invoice number</label>
        <input
          id="fn"
          value={f.number}
          onChange={set('number')}
          maxLength={64}
        />
      </div>
      <div className="field">
        <label htmlFor="ft">Total ({sym})</label>
        <input
          id="ft"
          inputMode="decimal"
          value={f.total}
          onChange={set('total')}
        />
      </div>
      {layout?.hasDescription && (
        <div className="field">
          <label htmlFor="fds">What it is for</label>
          <input
            id="fds"
            value={f.description}
            onChange={set('description')}
            maxLength={200}
          />
        </div>
      )}
      {layout?.hasDue && (
        <div className="field">
          <label htmlFor="fd">Due date</label>
          <input id="fd" type="date" value={f.due} onChange={set('due')} />
        </div>
      )}
      <div className="field">
        <label htmlFor="fna">From name</label>
        <input
          id="fna"
          value={fromName}
          onChange={set('fromName')}
          maxLength={200}
        />
      </div>
      <div className="field">
        <label htmlFor="fe">From email</label>
        <input
          id="fe"
          type="email"
          value={fromEmail}
          onChange={set('fromEmail')}
          maxLength={254}
        />
      </div>
      <div className="field full">
        <label htmlFor="fs">Subject</label>
        <input
          id="fs"
          value={f.subject}
          placeholder={`Invoice ${f.number.trim() || 'number'}`}
          onChange={set('subject')}
          maxLength={300}
        />
      </div>
      <div className="field full">
        <label htmlFor="fb">Body</label>
        <textarea
          id="fb"
          rows={4}
          value={f.body}
          onChange={set('body')}
          maxLength={20000}
        />
      </div>
      {doc && (
        <div className="computed full">
          <span className="label">Document the agent will read</span>
          <pre className="docpre">{JSON.stringify(doc, null, 2)}</pre>
        </div>
      )}
      <div className="computed full" aria-live="polite">
        <span className="label">Invoice id, computed in your browser</span>
        <span>{id || '…'}</span>
      </div>
      {err && <small className="sheet-err full">{err}</small>}
      <div className="full">
        <button className="btn solid magnet" type="submit" disabled={busy}>
          {busy ? 'Queueing…' : 'Queue invoice'}
        </button>
      </div>
    </form>
  )
}

function Inbox() {
  const inv = useInvoices()
  const vendors = useVendors()
  const now = useNow(30_000)
  const [filter, setFilter] = useState('All')
  const [open, setOpen] = useState<InvoiceItem | null>(null)
  const [adding, setAdding] = useState(false)
  const items = inv.data?.pages.flatMap((p) => p.items) ?? []
  const vendorName = (doc: Record<string, unknown>) =>
    vendors.data?.items.find((v) => v.id === doc.vendor_id)?.legalName ??
    'Unknown vendor'
  const list = items.filter(FILTERS[filter])
  const proposals = useProposals()
  // Once the owner decides a proposal, show that outcome instead of the agent's "Proposed".
  const decisionLabel = (i: InvoiceItem) => {
    const d = i.decision
    if (d?.kind !== 'Proposed') return d?.kind
    const p = proposals.data?.items.find((x) => x.proposalId === d.ref_id)
    return p && p.status !== 'Pending' ? p.status : d.kind
  }

  return (
    <section className="view">
      <h1 className="disp vt">
        <span className="mline">
          <span>Inbox</span>
        </span>
      </h1>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Filter">
          {Object.keys(FILTERS).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={k === filter}
              onClick={() => setFilter(k)}
            >
              {k}
            </button>
          ))}
        </div>
        <button
          className="btn solid sm magnet"
          type="button"
          onClick={() => setAdding(true)}
        >
          Add invoice <span className="arr">+</span>
        </button>
      </div>
      {inv.isError ? (
        <ErrorState
          what="the inbox"
          error={inv.error}
          retry={() => inv.refetch()}
        />
      ) : (
        <div className="panel" style={{ padding: '8px 8px 0' }}>
          <div className="tbox">
            <table className="t">
              <thead>
                <tr>
                  <th className="hide-sm">Delivered</th>
                  <th>From</th>
                  <th className="hide-sm">Subject</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {inv.isLoading &&
                  [0, 1, 2, 3].map((i) => (
                    <tr key={i}>
                      <td colSpan={4}>
                        <Skel />
                      </td>
                    </tr>
                  ))}
                {list.map((i) => (
                  <tr
                    key={i.invoiceId}
                    className="rowlink"
                    tabIndex={0}
                    onClick={() => setOpen(i)}
                    onKeyDown={(e) => e.key === 'Enter' && setOpen(i)}
                  >
                    <td className="m hide-sm">
                      {now ? ago(Date.parse(i.deliverAt), now) : ''}
                    </td>
                    <td>
                      <b style={{ fontWeight: 600 }}>
                        {vendorName(i.document)}
                      </b>
                      <br />
                      <span className="mono dimt" style={{ fontSize: 12 }}>
                        {i.email.from_email}
                      </span>
                      <span className="show-sm">{i.email.subject}</span>
                    </td>
                    <td className="hide-sm">{i.email.subject}</td>
                    <td>
                      {i.decisionUnavailable ? (
                        <span className="chip dash">Unavailable</span>
                      ) : i.decision ? (
                        <span
                          className={`chip${i.decision.kind === 'Paid' ? ' paperc' : i.decision.kind === 'Proposed' ? ' solid' : ''}`}
                        >
                          {decisionLabel(i)}
                        </span>
                      ) : (
                        <span className="chip dash">Waiting</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!inv.isLoading && !list.length && (
                  <tr>
                    <td
                      colSpan={4}
                      className="m"
                      style={{ padding: '24px 12px' }}
                    >
                      {items.length
                        ? 'Nothing in this filter.'
                        : 'No invoices delivered yet. Add one, or wait for the next tick.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {inv.hasNextPage && (
        <button
          className="btn ghost sm"
          type="button"
          style={{ marginTop: 12 }}
          onClick={() => inv.fetchNextPage()}
          disabled={inv.isFetchingNextPage}
        >
          Load older
        </button>
      )}
      <p className="dimt" style={{ fontSize: 13.5, marginTop: 14 }}>
        Tests are not marked here, by design. You see what the agent saw.{' '}
        <span className="src">GET /invoices · get_decision</span>
      </p>

      {open && (
        <Drawer title={vendorName(open.document)} onClose={() => setOpen(null)}>
          <div className="mailbox">
            <span className="label">{open.email.from_name}</span>
            <span className="mono dimt" style={{ fontSize: 12.5 }}>
              {open.email.from_email}
            </span>
            <b style={{ fontSize: 17 }}>{open.email.subject}</b>
            {open.email.body && <pre>{open.email.body}</pre>}
          </div>
          <dl className="kv">
            <dt>invoice id</dt>
            <dd>{open.invoiceId}</dd>
            <dt>delivered</dt>
            <dd>{utcStamp(Date.parse(open.deliverAt))}</dd>
            <dt>decision</dt>
            <dd>
              {open.decision
                ? `${open.decision.kind} · ${utcStamp(nsToMs(open.decision.at))}`
                : 'not decided yet'}
            </dd>
            {open.decision && (
              <>
                <dt>signed by</dt>
                <dd>{short(open.decision.key, 12, 6)}</dd>
                <dt>payee</dt>
                <dd>{open.decision.payee ?? '–'}</dd>
                <dt>payee approved</dt>
                <dd>{String(open.decision.payee_approved)}</dd>
              </>
            )}
          </dl>
          <span className="src">GET /invoices · get_decision(invoice_id)</span>
        </Drawer>
      )}
      {adding && (
        <Drawer title="Add invoice" onClose={() => setAdding(false)}>
          <AddInvoice onClose={() => setAdding(false)} />
        </Drawer>
      )}
    </section>
  )
}
