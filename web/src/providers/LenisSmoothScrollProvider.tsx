import Lenis from 'lenis'
import { useEffect } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { lenisRef } from '@/lib/lenis'

gsap.registerPlugin(ScrollTrigger)

export default function LenisSmoothScrollProvider() {
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const lenis = new Lenis({ lerp: 0.1, smoothWheel: true })
    lenisRef.set(lenis)
    lenis.on('scroll', ScrollTrigger.update)
    const tick = (time: number) => lenis.raf(time * 1000)
    gsap.ticker.add(tick)
    gsap.ticker.lagSmoothing(0)
    return () => {
      gsap.ticker.remove(tick)
      lenis.destroy()
      lenisRef.set(null)
    }
  }, [])

  return null
}
