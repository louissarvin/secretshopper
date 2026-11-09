import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'

const TARGETS =
  '[data-target], .btn, a, button, tr.rowlink, select, [role="tab"]'

/**
 * Site-wide pointer effects from React Bits, rebuilt on GSAP: Target Cursor (brackets lock onto anything
 * actionable), Magnet (any .magnet element leans toward the pointer) and Click Spark. Fine pointers only;
 * all of it is off with reduced motion.
 */
export default function Interactions() {
  const cur = useRef<HTMLDivElement>(null)
  const sparks = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const fine = matchMedia('(pointer: fine)').matches
    if (reduce) return
    const cleanups: Array<() => void> = []
    const on = <TKey extends keyof WindowEventMap>(
      t: TKey,
      f: (e: WindowEventMap[TKey]) => void,
      o?: AddEventListenerOptions,
    ) => {
      window.addEventListener(t, f, o)
      cleanups.push(() => window.removeEventListener(t, f, o))
    }

    // Click Spark
    const sc = sparks.current!
    const sx = sc.getContext('2d')!
    let list: Array<{ x: number; y: number; a: number; t: number; c: string }> =
      []
    let running = false
    const size = () => {
      const d = Math.min(devicePixelRatio || 1, 2)
      sc.width = innerWidth * d
      sc.height = innerHeight * d
      sx.setTransform(d, 0, 0, d, 0, 0)
    }
    size()
    on('resize', size)
    const draw = (now: number) => {
      sx.clearRect(0, 0, innerWidth, innerHeight)
      list = list.filter((s) => now - s.t < 420)
      for (const s of list) {
        const k = (now - s.t) / 420
        const r1 = 6 + 26 * (1 - Math.pow(1 - k, 3))
        const r2 = r1 + 10 * (1 - k)
        sx.strokeStyle = s.c
        sx.lineWidth = 2
        sx.beginPath()
        sx.moveTo(s.x + Math.cos(s.a) * r1, s.y + Math.sin(s.a) * r1)
        sx.lineTo(s.x + Math.cos(s.a) * r2, s.y + Math.sin(s.a) * r2)
        sx.stroke()
      }
      if (list.length) requestAnimationFrame(draw)
      else running = false
    }
    on('pointerdown', (e) => {
      const el = e.target as Element | null
      const c = el?.closest('.cobbg, .btn.solid, .chip.solid, .oc-Failed')
        ? '#EBEAE6'
        : '#3A4CFF'
      const t = performance.now()
      for (let i = 0; i < 8; i++)
        list.push({ x: e.clientX, y: e.clientY, a: (Math.PI * i) / 4, t, c })
      if (!running) {
        running = true
        requestAnimationFrame(draw)
      }
    })

    if (!fine) return () => cleanups.forEach((f) => f())

    // Magnet, by delegation so it works for elements rendered later
    const mags = new WeakMap<
      Element,
      { x: (v: number) => void; y: (v: number) => void }
    >()
    let magEl: Element | null = null
    const magOf = (el: Element) => {
      let m = mags.get(el)
      if (!m) {
        m = {
          x: gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3' }),
          y: gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3' }),
        }
        mags.set(el, m)
      }
      return m
    }

    // Target Cursor
    const tc = cur.current!
    const box = tc.querySelector('.box')!
    const dot = tc.querySelector('.dot')!
    const dx = gsap.quickTo(dot, 'x', { duration: 0.08 })
    const dy = gsap.quickTo(dot, 'y', { duration: 0.08 })
    const spin = gsap.to(box, {
      rotation: 360,
      duration: 4,
      ease: 'none',
      repeat: -1,
    })
    let lock: Element | null = null
    let seen = false
    document.documentElement.classList.add('has-tcur')
    cleanups.push(
      () => document.documentElement.classList.remove('has-tcur'),
      () => spin.kill(),
    )

    let px = 0
    let py = 0
    // Runs on pointer moves and on scroll, so the brackets follow whatever is under the pointer now.
    const track = (x: number, y: number, el: Element | null) => {
      px = x
      py = y
      dx(x)
      dy(y)

      const mag = el?.closest('.magnet') ?? null
      if (magEl && magEl !== mag) {
        const m = magOf(magEl)
        m.x(0)
        m.y(0)
      }
      magEl = mag
      if (mag) {
        const r = mag.getBoundingClientRect()
        const m = magOf(mag)
        m.x((x - r.left - r.width / 2) * 0.3)
        m.y((y - r.top - r.height / 2) * 0.4)
      }

      const t = el?.closest(TARGETS) ?? null
      tc.classList.toggle('on-light', !!el?.closest('.paper, .sheet') && !t)
      tc.classList.toggle('on-cob', !!el?.closest('.cobbg, .btn.solid'))
      if (t !== lock) {
        lock = t
        tc.classList.toggle('locked', !!t)
        if (t) spin.pause()
        else
          gsap.to(box, {
            width: 28,
            height: 28,
            marginLeft: -14,
            marginTop: -14,
            rotation: 0,
            duration: 0.3,
            ease: 'power3.out',
            onComplete: () => void (lock || spin.restart()),
          })
      }
      if (lock?.isConnected) {
        const r = lock.getBoundingClientRect()
        const p = 6
        gsap.to(box, {
          x: r.left - p,
          y: r.top - p,
          width: r.width + p * 2,
          height: r.height + p * 2,
          marginLeft: 0,
          marginTop: 0,
          rotation: 0,
          duration: 0.25,
          ease: 'power3.out',
          overwrite: 'auto',
        })
      } else
        gsap.to(box, {
          x,
          y,
          duration: 0.12,
          ease: 'power3.out',
          overwrite: 'auto',
        })
    }
    on('pointermove', (e) => {
      if (!seen) {
        seen = true
        gsap.set([dot, box], { x: e.clientX, y: e.clientY })
        gsap.to(tc, { opacity: 1, duration: 0.2 })
      }
      track(e.clientX, e.clientY, e.target as Element | null)
    })
    let raf = 0
    on(
      'scroll',
      () => {
        if (!seen || raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          track(px, py, document.elementFromPoint(px, py))
        })
      },
      { passive: true },
    )
    const hide = () => gsap.to(tc, { opacity: 0, duration: 0.2 })
    const show = () => seen && gsap.to(tc, { opacity: 1, duration: 0.2 })
    document.addEventListener('pointerleave', hide)
    document.addEventListener('pointerenter', show)
    cleanups.push(
      () => document.removeEventListener('pointerleave', hide),
      () => document.removeEventListener('pointerenter', show),
    )

    return () => cleanups.forEach((f) => f())
  }, [])

  return (
    <>
      <div className="tcur" ref={cur} aria-hidden="true">
        <div className="box">
          <i className="c tl" />
          <i className="c tr" />
          <i className="c bl" />
          <i className="c br" />
        </div>
        <div className="dot" />
      </div>
      <canvas className="sparks" ref={sparks} aria-hidden="true" />
    </>
  )
}
