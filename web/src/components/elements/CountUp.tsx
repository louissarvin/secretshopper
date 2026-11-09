import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

interface Props {
  to: number
  decimals?: number
  duration?: number
  className?: string
}

/** Count Up: counts from 0 once it scrolls into view. Renders the final value on the server and with reduced motion. */
export default function CountUp({
  to,
  decimals = 0,
  duration = 1.4,
  className,
}: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  const fmt = (v: number) =>
    v.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })

  useEffect(() => {
    const el = ref.current
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const o = { v: 0 }
    el.textContent = fmt(0)
    const tw = gsap.to(o, {
      v: to,
      duration,
      ease: 'power3.out',
      paused: true,
      onUpdate: () => void (el.textContent = fmt(o.v)),
    })
    const st = ScrollTrigger.create({
      trigger: el,
      start: 'top 95%',
      once: true,
      onEnter: () => void tw.play(),
    })
    return () => {
      st.kill()
      tw.kill()
      el.textContent = fmt(to)
    }
  }, [to, decimals, duration])

  return (
    <span ref={ref} className={className}>
      {fmt(to)}
    </span>
  )
}
