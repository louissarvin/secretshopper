import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

const WORD = 'SECRET SHOPPER'
const FONT = '"Archivo Variable", "Helvetica Neue", Arial, sans-serif'

interface Props {
  /** Element whose bottom edge drives the assembly; defaults to the canvas itself */
  revealTrigger?: string
}

/**
 * Footer wordmark after Darkroom and Resend: the word is cut into scanline slices that fly in and assemble as
 * the footer arrives, then bend and turn cobalt around the pointer, with a short glitch every few seconds.
 */
export default function ScanlineWordmark({ revealTrigger }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const mc = canvas.getContext('2d')!
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const off = document.createElement('canvas')
    const offB = document.createElement('canvas')
    const oc = off.getContext('2d')!
    const ocB = offB.getContext('2d')!
    let MW = 0
    let MH = 0
    let dpr = 1
    let slice = 5
    let scat: Array<number> = []
    let amp = reduce ? 0 : 1
    let fx = -9999
    let fy = -9999
    let visible = false
    let burstT = 0

    const font = (ctx: CanvasRenderingContext2D, size: number) => {
      ctx.font = `900 ${size}px ${FONT}`
      try {
        ;(ctx as any).fontStretch = 'expanded'
      } catch {}
      ctx.textBaseline = 'alphabetic'
    }
    const draw = (now: number) => {
      if (!MW) return
      const t = now / 1000
      const W = MW * dpr
      const s = slice * dpr
      const R = Math.max(120, MW * 0.14)
      const burst = now < burstT
      mc.clearRect(0, 0, W, MH * dpr)
      for (let i = 0, y = 0; y < MH; i++, y += slice) {
        const k =
          fy > -9000 ? Math.max(0, 1 - Math.abs(y - fy) / (MH * 0.55)) : 0
        let dx = scat[i] * amp
        if (k > 0) dx += Math.sin(y * 0.09 + t * 7) * 24 * k
        if (burst && i % 5 === ((now / 60) | 0) % 5)
          dx += (Math.random() - 0.5) * 40
        const h = Math.max(1, s - Math.round(dpr * (1 + amp * 2)))
        mc.globalAlpha = 1 - amp * 0.7
        mc.drawImage(off, 0, y * dpr, W, h, dx * dpr, y * dpr, W, h)
        if (k > 0.15) {
          const x0 = Math.max(0, fx - R)
          const w = Math.min(MW, fx + R) - x0
          if (w > 0)
            mc.drawImage(
              offB,
              x0 * dpr,
              y * dpr,
              w * dpr,
              h,
              (x0 + dx) * dpr,
              y * dpr,
              w * dpr,
              h,
            )
        }
      }
      mc.globalAlpha = 1
    }
    const build = () => {
      dpr = Math.min(devicePixelRatio || 1, 2)
      MW = canvas.clientWidth
      if (!MW) return
      font(oc, 200)
      const size = (200 * MW) / (oc.measureText(WORD).width + 4)
      const asc = size * 0.74
      MH = Math.ceil(asc + size * 0.04)
      for (const c of [canvas, off, offB]) {
        c.width = MW * dpr
        c.height = MH * dpr
      }
      canvas.style.height = `${MH}px`
      for (const [ctx, col] of [
        [oc, '#EBEAE6'],
        [ocB, '#3A4CFF'],
      ] as const) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, MW, MH)
        font(ctx, size)
        ctx.fillStyle = col
        ctx.fillText(WORD, (MW - ctx.measureText(WORD).width) / 2, asc)
      }
      slice = Math.max(3, Math.round(MH / 34))
      scat = Array.from(
        { length: Math.ceil(MH / slice) },
        () => (Math.random() - 0.5) * MW * 0.9,
      )
      draw(performance.now())
    }

    document.fonts.load(`900 100px ${FONT}`).then(build, build)
    window.addEventListener('resize', build)
    const io = new IntersectionObserver(
      (es) => (visible = es[0].isIntersecting),
    )
    io.observe(canvas)
    if (reduce)
      return () => (
        window.removeEventListener('resize', build),
        io.disconnect()
      )

    const host = (canvas.closest('footer') ?? canvas.parentElement)!
    const move = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      fx = e.clientX - r.left
      fy = e.clientY - r.top
    }
    const leave = () => (fx = fy = -9999)
    const enter = () => (burstT = performance.now() + 260)
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerleave', leave)
    canvas.addEventListener('pointerenter', enter)
    const st = ScrollTrigger.create({
      trigger: revealTrigger ?? canvas,
      start: revealTrigger ? 'bottom bottom' : 'top bottom',
      end: revealTrigger ? 'bottom 20%' : 'bottom bottom',
      scrub: 0.6,
      onUpdate: (s) => (amp = gsap.parseEase('power3.out')(1 - s.progress)),
    })
    const tick = () => {
      if (visible) draw(performance.now())
    }
    gsap.ticker.add(tick)
    const glitch = setInterval(() => {
      if (visible && amp < 0.05) burstT = performance.now() + 180
    }, 3200)
    return () => {
      window.removeEventListener('resize', build)
      io.disconnect()
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('pointerenter', enter)
      st.kill()
      gsap.ticker.remove(tick)
      clearInterval(glitch)
    }
  }, [revealTrigger])

  return (
    <>
      <canvas
        ref={ref}
        aria-hidden="true"
        style={{ display: 'block', width: '100%' }}
      />
      <span className="sr-only">Secret Shopper</span>
    </>
  )
}
