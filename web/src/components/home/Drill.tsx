import { useEffect, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { Link } from '@tanstack/react-router'
import { commitmentOf } from '@/lib/near/proofs'
import {
  usePublicTest,
  usePublicTests,
  useRelease,
  useTestSlot,
} from '@/hooks/useShop'
import { short } from '@/utils/near'
import { config, explorerTx } from '@/config'
import { scrambleAt } from '@/components/elements/DecryptedText'

gsap.registerPlugin(ScrollTrigger, useGSAP)

const TOTAL = 5.35

// The three genuine cards are labelled examples at testnet scale; real invoices are private to the owner.
const EXAMPLES = [
  { av: 'HF', name: 'Halden Freight', mail: 'example invoice', amt: '1.24' },
  { av: 'CC', name: 'Corvid Cloud', mail: 'example invoice', amt: '0.64' },
  { av: 'LM', name: 'Lumen Mills', mail: 'example invoice', amt: '0.92' },
]

const hhmm = (iso: string) => iso.slice(11, 16)

const STEPS = [
  [
    'Commit',
    'The tester writes a lure invoice and seals its hash into the vault before anyone sees it. The answer key is timelocked to drand, so nobody can change it later.',
  ],
  [
    'Deliver',
    'The lure lands in the same inbox, on the same tick, as real invoices. Nothing marks it. The agent signs a Merkle root over what it received.',
  ],
  [
    'Decide',
    'The agent signs a payment with its own key. The vault checks the per-payment cap, the 24 hour cap and the new-payee limit on every call.',
  ],
  [
    'Reveal',
    'The hash is recomputed and matches the one sealed before delivery. The agent paid a fake. The slot scores Failed.',
  ],
  [
    'Demote',
    'In the same receipt the key loses pay. The agent can still propose payments, and a person approves each one until the company and the vendor re-arm it together.',
  ],
] as const

export default function Drill() {
  const ref = useRef<HTMLElement>(null)
  const shop = config.shopId
  // Replays the newest Failed test on the vault: everything below is read from the chain and the public API
  const tests = usePublicTests(shop)
  const slot = tests.data?.pages
    .flatMap((p) => p.items)
    .filter((t) => t.revealed && t.status === 'Failed')
    .sort((x, y) => y.slotIndex - x.slotIndex)[0]?.slotIndex
  const pub = usePublicTest(shop, slot ?? -1, slot !== undefined)
  const chain = useTestSlot(shop, slot ?? -1, slot !== undefined)
  const deliverAt = pub.data?.invoice?.deliverAt
  const release = useRelease(
    shop,
    deliverAt ? String(BigInt(Date.parse(deliverAt)) * 1_000_000n) : undefined,
  )
  const committed = pub.data?.commitment ?? ''
  const [recomputed, setRecomputed] = useState('')
  // GSAP callbacks run on scroll, after the data arrives, so they read the latest value
  const committedRef = useRef(committed)
  committedRef.current = committed

  useEffect(() => {
    const r = chain.data?.reveal
    if (!r) return
    commitmentOf(r.salt, r.payee, r.invoice_id, r.receipt_hash).then(
      setRecomputed,
      () => setRecomputed('crypto.subtle is unavailable in this browser'),
    )
  }, [chain.data])

  const inv = pub.data?.invoice
  const doc = inv?.document
  const lure = inv
    ? {
        av: inv.email.from_name
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w.charAt(0))
          .join('')
          .toUpperCase(),
        name: inv.email.from_name,
        mail: inv.email.from_email,
        amt: String(doc?.amount_due ?? doc?.total ?? ''),
      }
    : null
  const cards = lure
    ? [EXAMPLES[0], EXAMPLES[1], { ...lure, lure: true }, EXAMPLES[2]]
    : []
  const day = deliverAt
    ? new Date(deliverAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : ''

  useGSAP(
    () => {
      const q = gsap.utils.selector(ref)
      const stage = q('.stage')[0] as HTMLElement
      const cardEls = q('.card') as Array<HTMLElement>
      // The cards render once the real lure is loaded
      if (cardEls.length < 4) return
      const lureEl = cardEls[2]
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
      const fit = () =>
        stage.style.setProperty(
          '--ch',
          `${Math.max(68, Math.min(116, stage.clientHeight / 4.7))}px`,
        )
      fit()
      const H = () => cardEls[0].offsetHeight
      const listY = (i: number) => (i - 1.5) * H() * 1.14
      const fan = [
        [-70, 26, -14],
        [-24, -6, -5],
        [24, -6, 5],
        [70, 26, 14],
      ]
      const blocks = q('.dblock')
      const bars = q('.dprog b')
      const tgt = q('.tgt')[0] as HTMLElement
      const tgtSize = () => {
        const w = lureEl.offsetWidth + 22
        const h = lureEl.offsetHeight + 22
        gsap.set(tgt, {
          width: w,
          height: h,
          marginLeft: -w / 2,
          marginTop: -h / 2,
        })
      }
      tgtSize()
      gsap.set(blocks.slice(1), { opacity: 0, y: 30 })
      cardEls.forEach((c, i) =>
        gsap.set(c, {
          x: fan[i][0],
          y: fan[i][1],
          rotation: fan[i][2],
          zIndex: c === lureEl ? 5 : i,
        }),
      )
      gsap.set(q('.seal'), { scaleX: 0 })
      gsap.set(q('.paychip'), { scale: 0, opacity: 0 })
      gsap.set(tgt, { opacity: 0, scale: 1.8 })
      gsap.set(q('.rootline span'), { opacity: 0, y: 8 })
      gsap.set(q('.stamp'), { scale: 2.4, opacity: 0 })
      gsap.set([q('.m-dem'), q('.log2')], { opacity: 0 })

      const sealHash = q('.seal code')[0]
      const backHash = q('.back code')[0]
      const seal = { p: 0 }
      const back = { p: 0 }
      const tl = gsap.timeline({
        defaults: { ease: 'power2.inOut' },
        scrollTrigger: {
          trigger: ref.current,
          start: 'top top',
          end: () => '+=' + innerHeight * 4.4,
          pin: true,
          scrub: reduce ? true : 0.8,
          invalidateOnRefresh: true,
          snap: reduce
            ? undefined
            : {
                snapTo: [
                  0,
                  0.9 / TOTAL,
                  1.95 / TOTAL,
                  2.9 / TOTAL,
                  3.95 / TOTAL,
                  1,
                ],
                duration: { min: 0.25, max: 0.7 },
                delay: 0.12,
                ease: 'power2.inOut',
              },
          onRefresh: () => (fit(), tgtSize()),
        },
      })
      for (let i = 0; i < 5; i++) {
        if (i > 0) {
          tl.to(
            q('.odo .col'),
            { yPercent: -20 * i, duration: 0.35, ease: 'expo.inOut' },
            i - 0.15,
          )
            .to(blocks[i - 1], { opacity: 0, y: -30, duration: 0.25 }, i - 0.2)
            .to(blocks[i], { opacity: 1, y: 0, duration: 0.3 }, i - 0.05)
        }
        tl.to(bars[i], { scaleX: 1, duration: 1, ease: 'none' }, i)
      }
      tl.to(q('.seal'), { scaleX: 1, duration: 0.5 }, 0.1)
        .to(
          seal,
          {
            p: 1,
            duration: 0.5,
            ease: 'none',
            onUpdate: () =>
              void (sealHash.textContent = scrambleAt(
                committedRef.current,
                seal.p,
              )),
          },
          0.2,
        )
        .to(lureEl, { y: -40, scale: 1.04, duration: 0.5 }, 0.1)
      cardEls.forEach((c, i) =>
        tl.to(
          c,
          { x: 0, y: () => listY(i), rotation: 0, scale: 1, duration: 0.7 },
          1.05 + i * 0.04,
        ),
      )
      tl.to(
        q('.seal'),
        { scaleX: 0, transformOrigin: 'right center', duration: 0.35 },
        1.25,
      ).to(
        q('.rootline span'),
        { opacity: 1, y: 0, duration: 0.25, stagger: 0.12 },
        1.5,
      )
      tl.to(
        tgt,
        {
          opacity: 1,
          scale: 1,
          y: () => listY(2),
          duration: 0.45,
          ease: 'expo.out',
        },
        2.05,
      )
        .to(
          q('.paychip'),
          { scale: 1, opacity: 1, duration: 0.3, ease: 'back.out(2)' },
          2.45,
        )
        .to(q('.rootline'), { opacity: 0.4, duration: 0.3 }, 2.2)
      tl.to(
        cardEls.filter((c) => c !== lureEl),
        { opacity: 0.2, duration: 0.3 },
        3.0,
      )
        .to(q('.paychip'), { opacity: 0, duration: 0.15 }, 3.0)
        .to(tgt, { opacity: 0, duration: 0.2 }, 3.05)
        .to(lureEl, { rotationY: 180, scale: 1.08, duration: 0.6 }, 3.1)
        .to(
          back,
          {
            p: 1,
            duration: 0.45,
            ease: 'none',
            onUpdate: () =>
              void (backHash.textContent = scrambleAt(
                backHash.dataset.v ?? committedRef.current,
                back.p,
              )),
          },
          3.3,
        )
        .to(
          q('.stamp'),
          { scale: 1, opacity: 1, duration: 0.25, ease: 'back.out(3)' },
          3.7,
        )
      tl.to(q('.strike'), { scaleX: 1, duration: 0.3 }, 4.05)
        .to(q('.flip'), { rotationX: 180, duration: 0.45 }, 4.4)
        .to(q('.m-arm'), { opacity: 0, duration: 0.2 }, 4.5)
        .to(q('.m-dem'), { opacity: 1, duration: 0.2 }, 4.55)
        .to(q('.log1'), { opacity: 0, duration: 0.2 }, 4.5)
        .to(q('.log2'), { opacity: 1, duration: 0.2 }, 4.6)
        .to({}, { duration: TOTAL - 5 }, 5)
    },
    { scope: ref, dependencies: [!!lure], revertOnUpdate: true },
  )

  return (
    <section
      className="drill"
      id="drill"
      ref={ref}
      aria-label="How a drill runs"
    >
      <div className="wrap">
        <div className="dtext">
          <p className="label">
            {slot !== undefined && day
              ? `A real drill: slot ${slot} on ${shop.split('.')[0]}, ${day} · scroll`
              : 'How a drill runs · scroll'}
          </p>
          <div className="odo" aria-hidden="true">
            <div className="col">
              {STEPS.map((_, i) => (
                <span key={i}>0{i + 1}</span>
              ))}
            </div>
          </div>
          <div className="dblocks">
            {STEPS.map(([h, p]) => (
              <div className="dblock" key={h}>
                <h3>{h}</h3>
                <p>{p}</p>
              </div>
            ))}
          </div>
          <div className="dprog" aria-hidden="true">
            {STEPS.map((_, i) => (
              <i key={i}>
                <b />
              </i>
            ))}
          </div>
        </div>
        <div className="stagewrap">
          <div className="stage">
            {cards.map((c) => (
              <div className="card" key={c.name}>
                <div className="face">
                  <span className="av">{c.av}</span>
                  <span className="who">
                    <b>{c.name}</b>
                    <small>{c.mail}</small>
                  </span>
                  <span className="amt">
                    {c.amt}
                    <small>USDC</small>
                  </span>
                  {'lure' in c && (
                    <div className="seal">
                      <small>Sealed commitment · slot {slot}</small>
                      <code>{committed}</code>
                    </div>
                  )}
                </div>
                {'lure' in c && (
                  <>
                    <div className="face back">
                      <span className="bh">
                        <small>
                          Recomputed ·{' '}
                          {recomputed && recomputed === committed
                            ? 'match'
                            : 'checking'}
                        </small>
                        <code data-v={recomputed}>{recomputed}</code>
                      </span>
                      <span className="stamp">FAILED</span>
                    </div>
                    <span className="paychip">pay() signed</span>
                  </>
                )}
              </div>
            ))}
            <div className="tgt" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <div className="rootline">
            {deliverAt && <span>release {hhmm(deliverAt)} UTC</span>}
            {release.data && <span>root {short(release.data.root, 4, 2)}</span>}
            {release.data?.ack && (
              <span className="ok">
                agent ack{' '}
                {release.data.ack.root === release.data.root
                  ? 'matched'
                  : 'mismatched'}
              </span>
            )}
          </div>
          {pub.data && (
            <div className="rootline drill-tx">
              {pub.data.commitTx && (
                <a
                  href={explorerTx(pub.data.commitTx.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  commit {short(pub.data.commitTx.txHash, 4, 2)}
                </a>
              )}
              {pub.data.decisionTx && (
                <a
                  href={explorerTx(pub.data.decisionTx.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  pay {short(pub.data.decisionTx.txHash, 4, 2)}
                </a>
              )}
              {pub.data.demotion && (
                <a
                  href={explorerTx(pub.data.demotion.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  reveal + demote {short(pub.data.demotion.txHash, 4, 2)}
                </a>
              )}
              <Link
                to="/s/$shopId/tests/$slot"
                params={{ shopId: shop, slot: String(slot) }}
              >
                open slot {slot}
              </Link>
            </div>
          )}
          <div className="keystrip">
            <div className="ks-top">
              <span className="label">Agent key</span>
              <span className="swap">
                <span className="mode m-arm">Armed</span>
                <span className="mode demoted m-dem">Demoted</span>
              </span>
            </div>
            <div className="meths">
              <span className="meth flip">
                <span className="f1">
                  pay
                  <i className="strike" />
                </span>
                <span className="f2">propose</span>
              </span>
              <span className="meth">decline</span>
              <span className="meth">ack</span>
            </div>
            <div className="ks-log swap">
              <span className="log1">
                Pays up to its daily cap without asking anyone.
              </span>
              <span className="log2">
                Next pay() is rejected by the runtime: method not allowed.
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
