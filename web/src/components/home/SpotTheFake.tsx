import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import type { PublicTest } from '@/lib/api/shop'
import DecryptedText from '@/components/elements/DecryptedText'
import { ErrorState, Skel } from '@/components/QueryState'
import { usePublicTest, usePublicTests } from '@/hooks/useShop'
import { short } from '@/utils/near'
import { config } from '@/config'

interface Item {
  av: string
  n: string
  m: string
  s: string
  d: string
  a: string
  why: string
  test?: boolean
}

// Genuine invoices are private to the owner, so these three are labelled examples at the vault's testnet scale.
const EXAMPLES: Array<Item> = [
  {
    av: 'HF',
    n: 'Halden Freight',
    m: 'ar@haldenfreight.example',
    s: 'October freight, lane 4 Rotterdam',
    d: 'due Dec 30',
    a: '1.24',
    why: 'Example invoice. Approved payee, the same account as its last six invoices.',
  },
  {
    av: 'CC',
    n: 'Corvid Cloud',
    m: 'invoices@corvid.example',
    s: 'Invoice CC-88213, November usage',
    d: 'due Dec 5',
    a: '0.64',
    why: 'Example invoice. Approved payee, amount within its usual range.',
  },
  {
    av: 'LM',
    n: 'Lumen Mills',
    m: 'finance@lumenmills.example',
    s: 'PO 3381, 40 reams recycled stock',
    d: 'due Dec 1',
    a: '0.92',
    why: 'Example invoice. Matches an open purchase order on file.',
  },
]

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')

/** The lure card, built from a real revealed test exactly as the agent received it. */
function lureOf(t: PublicTest): Item | null {
  const inv = t.invoice
  if (!inv) return null
  const doc = inv.document
  const amount = String(doc.amount_due ?? doc.total ?? '')
  const due = typeof doc.due === 'string' ? doc.due : null
  return {
    av: initials(inv.email.from_name) || 'LU',
    n: inv.email.from_name,
    m: inv.email.from_email,
    s: inv.email.subject,
    d: `${due ? 'due' : 'sent'} ${monthDay(due ?? inv.deliverAt)}`,
    a: amount,
    why: `The real lure from test slot ${t.slotIndex}. Its payee ${short(t.revealedPayee, 8, 6)} was never approved for this vendor, and the test was committed on chain before delivery. ${t.status === 'Failed' ? 'An agent paid it and lost the right to pay.' : 'Our agent declined it.'}`,
    test: true,
  }
}

// "Dec 12", the way the example cards write dates
const monthDay = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString(
    'en-US',
    { month: 'short', day: 'numeric', timeZone: 'UTC' },
  )

const shuffle = (xs: Array<Item>) => [...xs].sort(() => Math.random() - 0.5)

function Card({
  v,
  open,
  onOpen,
}: {
  v: Item
  open: boolean
  onOpen: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  // Tilted Card hover on fine pointers
  useEffect(() => {
    const b = ref.current!
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    gsap.set(b, { transformPerspective: 900 })
    const rx = gsap.quickTo(b, 'rotationX', { duration: 0.5, ease: 'power3' })
    const ry = gsap.quickTo(b, 'rotationY', { duration: 0.5, ease: 'power3' })
    const fine = matchMedia('(pointer: fine)').matches
    const move = (e: PointerEvent) => {
      const r = b.getBoundingClientRect()
      b.style.setProperty('--mx', `${e.clientX - r.left}px`)
      b.style.setProperty('--my', `${e.clientY - r.top}px`)
      if (fine) {
        rx(-((e.clientY - r.top) / r.height - 0.5) * 10)
        ry(((e.clientX - r.left) / r.width - 0.5) * 12)
      }
    }
    const leave = () => (rx(0), ry(0), b.style.setProperty('--mx', '-999px'))
    b.addEventListener('pointermove', move)
    b.addEventListener('pointerleave', leave)
    return () => (
      b.removeEventListener('pointermove', move),
      b.removeEventListener('pointerleave', leave)
    )
  }, [])
  return (
    <button
      ref={ref}
      className={`gc${open ? ' open' : ''}`}
      type="button"
      onClick={onOpen}
      aria-pressed={open}
      aria-label={`${v.n}, ${v.a} USDC. ${open ? (v.test ? 'This is the test.' : 'Real invoice.') : 'Open to see if it is the test.'}`}
    >
      <span className="in">
        <span className="gf">
          <span className="top">
            <span className="from">
              <span className="av">{v.av}</span>
              <span style={{ minWidth: 0 }}>
                <b>{v.n}</b>
                <small>{v.m}</small>
              </span>
            </span>
            <span className="amt">{v.a} USDC</span>
          </span>
          <span className="subj">
            <span>{v.s}</span>
            <i>{v.d}</i>
          </span>
        </span>
        <span className={`gb${v.test ? ' test' : ''}`}>
          <span className="verdict">{v.test ? 'The test' : 'Real'}</span>
          <span className="why">
            {open ? <DecryptedText text={v.why} duration={0.8} /> : v.why}
          </span>
        </span>
      </span>
    </button>
  )
}

export default function SpotTheFake() {
  const tests = usePublicTests(config.shopId)
  // The newest revealed slot that held a lure (void and invalid slots have none)
  const slot = tests.data?.pages
    .flatMap((p) => p.items)
    .filter((t) => t.revealed && ['Passed', 'Failed'].includes(t.status))
    .sort((x, y) => y.slotIndex - x.slotIndex)[0]?.slotIndex
  const test = usePublicTest(config.shopId, slot ?? -1, slot !== undefined)
  const lure = test.data ? lureOf(test.data) : null
  const [order, setOrder] = useState<Array<Item>>([])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const grid = useRef<HTMLDivElement>(null)

  const deal = () => {
    if (lure) setOrder(shuffle([...EXAMPLES, lure]))
    setOpen(new Set())
  }
  useEffect(() => {
    if (lure) setOrder(shuffle([...EXAMPLES, lure]))
    // a new lure arrives only with new data
  }, [test.data])
  useEffect(() => {
    if (!order.length) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    gsap.from(grid.current!.children, {
      y: 40,
      opacity: 0,
      duration: 0.8,
      ease: 'expo.out',
      stagger: 0.07,
    })
  }, [order])

  const found = order.some((v) => v.test && open.has(v.m))
  const last = [...open].at(-1)
  const msg = !open.size
    ? 'Pick the one you would not pay'
    : found
      ? 'Found it. Your agent gets the same clues.'
      : last && !order.find((v) => v.m === last)?.test
        ? 'That one is real. Keep looking.'
        : ''

  return (
    <section className="paper guess" id="guess">
      <div className="wrap">
        <div className="grid12 ghead">
          <h2 className="disp rv">
            <span className="mline">
              <span>Spot</span>
            </span>
            <span className="mline">
              <span className="cob">the fake.</span>
            </span>
          </h2>
          <div className="gside">
            <p>
              Four invoices. Three are examples; one is a real lure our agent
              received on testnet, word for word. Your agent sees exactly this,
              with no hint that a test exists.
            </p>
          </div>
        </div>
        <div className="inboxbar">
          <span>
            {lure && slot !== undefined
              ? `Example inbox · the lure is test slot ${slot}, live from the vault`
              : 'Example inbox'}
          </span>
          <span aria-live="polite">{msg}</span>
        </div>
        {tests.isError || test.isError ? (
          <ErrorState
            what="the real lure"
            error={tests.error ?? test.error}
            retry={() => (tests.refetch(), test.refetch())}
          />
        ) : !order.length ? (
          <Skel h={420} />
        ) : (
          <div className="ggrid" ref={grid}>
            {order.map((v) => (
              <Card
                key={v.m}
                v={v}
                open={open.has(v.m)}
                onOpen={() => setOpen((x) => new Set(x).add(v.m))}
              />
            ))}
          </div>
        )}
        <div className="gfoot">
          <p>{open.size} of 4 opened</p>
          <button className="btn ink sm magnet" type="button" onClick={deal}>
            Shuffle and reset
          </button>
        </div>
      </div>
    </section>
  )
}
