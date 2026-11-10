export interface InvoiceFields {
  number: string
  total: string // decimal USDC
  description: string
  due: string // YYYY-MM-DD
  payee: string
  billTo: string
  today: string // YYYY-MM-DD, UTC
}

type Doc = Record<string, unknown>

const NUMBER_KEYS = ['number', 'invoice_no', 'ref']

// Replaces the API's sample placeholders anywhere in the document.
const fill = (v: unknown, f: InvoiceFields): unknown => {
  if (v === '<account>') return f.payee
  if (v === '<company>') return f.billTo
  if (Array.isArray(v)) return v.map((x) => fill(x, f))
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, fill(x, f)]),
    )
  return v
}

const prevMonth = (day: string) => {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}

/** The fields a vendor's layout uses, so the form only asks for those. */
export const layoutOf = (template: Doc) => ({
  hasDue: 'due' in template,
  hasDescription: 'lines' in template || 'service' in template,
})

/**
 * Builds an invoice in the vendor's own layout (its latest sample), so the agent sees
 * the same shape it knows from that vendor, with the payee in the vendor's payee field.
 */
export function buildInvoice(template: Doc, f: InvoiceFields): Doc {
  const doc = fill(template, f) as Doc
  for (const k of NUMBER_KEYS) if (k in doc) doc[k] = f.number
  for (const k of ['total', 'amount_due']) if (k in doc) doc[k] = f.total
  if ('issued' in doc) doc.issued = f.today
  if ('due' in doc) doc.due = f.due
  if ('period' in doc) doc.period = prevMonth(f.today)
  if ('service' in doc) doc.service = f.description
  const lines = doc.lines
  if (Array.isArray(lines) && lines[0])
    doc.lines = [
      { ...lines[0], qty: 1, unit_price: f.total, description: f.description },
    ]
  const items = doc.items
  if (Array.isArray(items) && items[0]) {
    const item = items[0] as Doc
    const rate = Number(item.amount) / Number(item.hours)
    doc.items = [
      {
        ...item,
        ...(rate > 0 && { hours: Math.round(Number(f.total) / rate) }),
        amount: f.total,
      },
    ]
  }
  return doc
}

const PAYEE_PATHS: Array<Array<string>> = [
  ['pay_to'],
  ['remit_to'],
  ['payment', 'account'],
]

/** Every payee field the vendor layouts use, so a sample cannot carry a hard-coded payee past the form. */
export function payeesOf(doc: Doc): Array<string> {
  const out: Array<string> = []
  for (const path of PAYEE_PATHS) {
    let v: unknown = doc
    for (const k of path)
      v = v && typeof v === 'object' ? (v as Doc)[k] : undefined
    if (v !== undefined) out.push(String(v))
  }
  return out
}

/** A sample usable as a template: a plain JSON object, not an array or a scalar. */
export const isTemplate = (v: unknown): v is Doc =>
  !!v && typeof v === 'object' && !Array.isArray(v)
