import { useEffect, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import { scrollToTarget } from '@/lib/lenis'
import { usePublicTests, useScorecard, useStatus } from '@/hooks/useShop'
import { config } from '@/config'

gsap.registerPlugin(ScrollTrigger, SplitText, useGSAP)

const HEX = '0123456789abcdef'

/** Letter Glitch: a field of hex that flickers, lit in cobalt under the pointer. */
function useLetterGlitch(
  canvas: React.RefObject<HTMLCanvasElement | null>,
  host: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const cv = canvas.current!
    const hostEl = host.current!
    const cx = cv.getContext('2d')!
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const CW = 18
    const CH = 22
    let cols = 0
    let rows = 0
    let cells: Array<{ c: string; b: boolean }> = []
    let mx = -999
    let my = -999
    let visible = true
    const size = () => {
      const r = cv.getBoundingClientRect()
      const dpr = Math.min(devicePixelRatio || 1, 2)
      cv.width = r.width * dpr
      cv.height = r.height * dpr
      cx.setTransform(dpr, 0, 0, dpr, 0, 0)
      cols = Math.ceil(r.width / CW)
      rows = Math.ceil(r.height / CH)
      cells = Array.from({ length: cols * rows }, () => ({
        c: HEX[(Math.random() * 16) | 0],
        b: Math.random() < 0.035,
      }))
      cx.font = '500 13px "Geist Mono Variable", ui-monospace, monospace'
      cx.textBaseline = 'top'
      draw()
    }
    const draw = () => {
      cx.clearRect(0, 0, cv.width, cv.height)
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const cell = cells[y * cols + x]
          const px = x * CW
          const py = y * CH
          const near = Math.max(0, 1 - Math.hypot(px - mx, py - my) / 240)
          cx.fillStyle =
            cell.b || (near > 0.5 && (x * 7 + y * 13) % 4 === 0)
              ? `rgba(58,76,255,${0.35 + near * 0.65})`
              : `rgba(235,234,230,${0.06 + near * 0.5})`
          cx.fillText(cell.c, px, py)
        }
    }
    size()
    document.fonts.ready.then(size)
    window.addEventListener('resize', size)
    const move = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect()
      mx = e.clientX - r.left
      my = e.clientY - r.top
    }
    const leave = () => (mx = my = -999)
    hostEl.addEventListener('pointermove', move)
    hostEl.addEventListener('pointerleave', leave)
    const io = new IntersectionObserver(
      (es) => (visible = es[0].isIntersecting),
    )
    io.observe(cv)
    let last = 0
    const tick = () => {
      const now = performance.now()
      if (!visible || now - last < 70) return
      last = now
      for (let i = 0; i < cells.length * 0.03; i++) {
        const c = cells[(Math.random() * cells.length) | 0]
        c.c = HEX[(Math.random() * 16) | 0]
        c.b = Math.random() < 0.035
      }
      draw()
    }
    if (!reduce) gsap.ticker.add(tick)
    return () => {
      window.removeEventListener('resize', size)
      hostEl.removeEventListener('pointermove', move)
      hostEl.removeEventListener('pointerleave', leave)
      io.disconnect()
      gsap.ticker.remove(tick)
    }
  }, [canvas, host])
}

export function Loader({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [gone, setGone] = useState(false)
  // The newest commitment sealed in the vault; until it loads the loader shows noise, not a stand-in hash
  const tests = usePublicTests(config.shopId)
  const latest = tests.data?.pages[0]?.items[0]?.commitment ?? ''
  const commit = useRef(latest)
  commit.current = latest
  useGSAP(
    () => {
      let seen = false
      try {
        seen = sessionStorage.getItem('ss-loader') === '1'
        sessionStorage.setItem('ss-loader', '1')
      } catch {}
      if (seen || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setGone(true)
        onDone()
        return
      }
      const n = { v: 0 }
      const num = ref.current!.querySelector('.ld-n')!
      const hash = ref.current!.querySelector('.ld-hash')!
      const h = { p: 0 }
      gsap
        .timeline({ onComplete: () => setGone(true) })
        .to(
          n,
          {
            v: 100,
            duration: 1.05,
            ease: 'power2.inOut',
            onUpdate: () =>
              void (num.textContent = String(Math.round(n.v)).padStart(2, '0')),
          },
          0,
        )
        .to(
          h,
          {
            p: 1,
            duration: 1,
            ease: 'none',
            onUpdate: () =>
              void (hash.textContent =
                commit.current.slice(0, Math.floor(h.p * 64)) +
                Array.from(
                  {
                    length:
                      64 -
                      Math.min(commit.current.length, Math.floor(h.p * 64)),
                  },
                  () => HEX[(Math.random() * 16) | 0],
                ).join('')),
          },
          0,
        )
        .to('.ld-bar i', { scaleX: 1, duration: 1.05, ease: 'power2.inOut' }, 0)
        .to(
          '.curtain',
          { yPercent: -100, duration: 0.55, ease: 'power3.in' },
          1.1,
        )
        .set('.ld', { opacity: 0 })
        .set(ref.current, { background: 'transparent' })
        .to('.curtain', { yPercent: -200, duration: 0.65, ease: 'power3.out' })
        .add(onDone, '-=0.5')
    },
    { scope: ref },
  )
  if (gone) return null
  return (
    <div className="loader" ref={ref} aria-hidden="true">
      <div className="ld">
        <span className="label">sealing batch</span>
        <div className="ld-n">00</div>
        <div className="ld-bar">
          <i />
        </div>
        <div className="ld-hash">{latest}</div>
      </div>
      <div className="curtain" />
    </div>
  )
}

export function Hero({ ready }: { ready: boolean }) {
  const section = useRef<HTMLElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const status = useStatus(config.shopId)
  const score = useScorecard(config.shopId)
  useLetterGlitch(canvas, section)

  useGSAP(
    () => {
      if (!ready) return
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
      const split = SplitText.create('#h1 .ln', {
        type: 'chars',
        charsClass: 'ch',
      })
      const chars = split.chars as Array<HTMLElement>
      if (!reduce) {
        gsap.from(chars, {
          yPercent: 110,
          filter: 'blur(10px)',
          duration: 1.1,
          ease: 'expo.out',
          stagger: 0.022,
        })
        gsap.from('.eyebrow, .sub, .hero-foot .acts, .ticker', {
          y: 24,
          opacity: 0,
          duration: 1,
          ease: 'expo.out',
          stagger: 0.08,
          delay: 0.35,
        })
        gsap.to('.hero-in', {
          yPercent: -18,
          ease: 'none',
          scrollTrigger: {
            trigger: section.current,
            start: 'top top',
            end: 'bottom top',
            scrub: true,
          },
        })
        gsap.to(canvas.current, {
          opacity: 0.25,
          ease: 'none',
          scrollTrigger: {
            trigger: section.current,
            start: 'top top',
            end: 'bottom top',
            scrub: true,
          },
        })
      }
      // Variable Proximity on Archivo's width and weight axes
      if (reduce || !matchMedia('(pointer: fine)').matches) return
      let rects: Array<[number, number]> = []
      const measure = () =>
        (rects = chars.map((c) => {
          const r = c.getBoundingClientRect()
          return [r.left + r.width / 2, r.top + r.height / 2]
        }))
      const state = chars.map(() => ({ w: 100, g: 800 }))
      const apply = (i: number) =>
        (chars[i].style.fontVariationSettings =
          `"wdth" ${state[i].w.toFixed(1)},"wght" ${state[i].g.toFixed(0)}`)
      let raf = 0
      const move = (e: PointerEvent) => {
        if (raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          if (!rects.length) measure()
          chars.forEach((_, i) => {
            const k = Math.max(
              0,
              1 -
                Math.hypot(e.clientX - rects[i][0], e.clientY - rects[i][1]) /
                  260,
            )
            gsap.to(state[i], {
              w: 100 + 25 * k,
              g: 800 + 100 * k,
              duration: 0.5,
              ease: 'power3.out',
              overwrite: true,
              onUpdate: () => void apply(i),
            })
          })
        })
      }
      const leave = () =>
        chars.forEach((_, i) =>
          gsap.to(state[i], {
            w: 100,
            g: 800,
            duration: 0.8,
            ease: 'power3.out',
            overwrite: true,
            onUpdate: () => void apply(i),
          }),
        )
      const reset = () => (rects = [])
      const el = section.current!
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerleave', leave)
      window.addEventListener('resize', reset)
      window.addEventListener('scroll', reset, { passive: true })
      return () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerleave', leave)
        window.removeEventListener('resize', reset)
        window.removeEventListener('scroll', reset)
        split.revert()
      }
    },
    { scope: section, dependencies: [ready] },
  )

  const s = status.data
  const sc = score.data
  const events = [
    ['vault', `${config.shopId}`],
    ['mode', s?.mode ?? '…'],
    ['contract', s?.version ?? '…'],
    ['tests committed', sc ? String(sc.stats.committed) : '…'],
    ['payments', sc ? String(sc.stats.payments) : '…'],
    ['declines', sc ? String(sc.stats.declines) : '…'],
    ['demotions', sc ? String(sc.stats.demotions) : '…'],
    ['releases posted', sc ? String(sc.stats.releases_posted) : '…'],
  ]
  const tick = events.map(([k, v]) => (
    <span key={k}>
      <i>{k}</i> <b>{v}</b>
    </span>
  ))

  return (
    <section className="hero" id="top" ref={section}>
      <canvas id="glitch" ref={canvas} aria-hidden="true" />
      <div className="wrap hero-in">
        <p className="eyebrow label">
          <span className="live" />
          Live on NEAR {config.network}
          {s ? ` · vault ${s.version} · ${s.mode}` : ''}
        </p>
        <h1 id="h1" aria-label="Every invoice could be the test.">
          <span className="ln">Every invoice</span>
          <span className="ln">could be</span>
          <span className="ln cob">the test.</span>
        </h1>
        <div className="hero-foot">
          <p className="sub">
            Secret Shopper hides committed fake invoices among the real ones
            your AI agent pays.{' '}
            <b>The vault holding the money grades every decision</b>, and the
            moment the agent pays a fake, it loses the right to pay.
          </p>
          <div className="acts">
            <a
              className="btn solid magnet"
              href="#drill"
              onClick={(e) => (e.preventDefault(), scrollToTarget('#drill', 0))}
            >
              See a drill <span className="arr">→</span>
            </a>
            <a
              className="btn ghost magnet"
              href="#guess"
              onClick={(e) => (e.preventDefault(), scrollToTarget('#guess'))}
            >
              Spot the fake
            </a>
          </div>
        </div>
      </div>
      <div className="ticker" aria-label="Live vault figures">
        <div className="tk">
          {tick}
          {tick}
        </div>
      </div>
    </section>
  )
}

export function VelocityBand() {
  const ref = useRef<HTMLElement>(null)
  useGSAP(
    () => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const rows = gsap.utils.toArray<HTMLElement>('.vrow').map((el, i) => ({
        el,
        dir: i ? 1 : -1,
        x: i ? -el.scrollWidth / 2 : 0,
      }))
      let vel = 0
      ScrollTrigger.create({
        trigger: ref.current,
        start: 'top bottom',
        end: 'bottom top',
        onUpdate: (s) => void (vel = s.getVelocity()),
      })
      const tick = (_: number, dt: number) => {
        const boost = 1 + Math.min(Math.abs(vel) / 350, 7)
        const sign = vel < -5 ? -1 : 1
        vel *= 0.9
        for (const r of rows) {
          const half = r.el.scrollWidth / 2
          r.x += r.dir * sign * 0.06 * dt * boost
          if (r.x < -half) r.x += half
          if (r.x > 0) r.x -= half
          r.el.style.transform = `translate3d(${r.x}px,0,0)`
        }
      }
      gsap.ticker.add(tick)
      return () => gsap.ticker.remove(tick)
    },
    { scope: ref },
  )
  const words = ['pay', 'decline', 'ack', 'propose', 'reveal', 'commit']
  const row = (list: Array<string>) =>
    [0, 1, 2, 3].flatMap((n) =>
      list.map((w) => (
        <span key={`${n}${w}`}>
          {w}
          <em />
        </span>
      )),
    )
  return (
    <section className="vband" ref={ref} aria-hidden="true">
      <div className="vrow">{row(words)}</div>
      <div className="vrow out">{row([...words].reverse())}</div>
    </section>
  )
}

export function Statement() {
  const ref = useRef<HTMLElement>(null)
  useGSAP(
    () => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const split = SplitText.create('#sr', { type: 'words' })
      gsap.fromTo(
        split.words,
        { opacity: 0.16 },
        {
          opacity: 1,
          ease: 'none',
          stagger: 0.1,
          scrollTrigger: {
            trigger: '#sr',
            start: 'top 82%',
            end: 'bottom 45%',
            scrub: true,
          },
        },
      )
      gsap.from('#cites > div', {
        y: 40,
        opacity: 0,
        duration: 1,
        ease: 'expo.out',
        stagger: 0.1,
        scrollTrigger: { trigger: '#cites', start: 'top 90%', once: true },
      })
      return () => split.revert()
    },
    { scope: ref },
  )
  return (
    <section className="paper statement" ref={ref}>
      <div className="wrap grid12">
        <p className="label st-label">The problem</p>
        <div className="st-body">
          <p className="sr" id="sr">
            AI agents now pay supplier invoices. The fraud that fools accounts
            payable staff,{' '}
            <span className="hl">"our bank details changed"</span>, now targets
            the agent. Nobody can show a pass rate for the agent that pays that
            neither the vendor nor the company could fake.
          </p>
          <div className="cites" id="cites">
            <div>
              <a
                className="label"
                href="https://thecurrencyanalytics.com/finance/visa-bill-billtrust-ai-agent-payment-pilot-306341"
                target="_blank"
                rel="noopener noreferrer"
              >
                Oct 20, 2026 · Visa, BILL, Billtrust
              </a>
              <p>
                Pilot lets AI agents complete approved invoice payments. The
                open question is proof the agent acts within instructions.
              </p>
            </div>
            <div>
              <a
                className="label"
                href="https://blog.predictap.com/gaming-the-agent-why-ai-invoice-approval-still-needs-an-independent-human-control"
                target="_blank"
                rel="noopener noreferrer"
              >
                Oct 29, 2026 · PredictAP
              </a>
              <p>
                Fraudsters learn how an AP agent decides and stay inside its
                rules. An audit trail is a log, not a control.
              </p>
            </div>
            <div>
              <a
                className="label"
                href="https://activantcapital.com/research/who-owns-the-risk-layer-for-ai/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Oct 15, 2026 · Activant
              </a>
              <p>
                There is no accepted record tying an agent's behaviour to the
                cost of an insured claim.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
