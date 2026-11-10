import type Lenis from 'lenis'

// The one Lenis instance, set by LenisSmoothScrollProvider. Null with reduced motion.
let instance: Lenis | null = null

export const lenisRef = {
  get: () => instance,
  set: (l: Lenis | null) => {
    instance = l
  },
}

export function scrollToTarget(
  target: string | HTMLElement | number,
  offset = -90,
) {
  const l = instance
  const reduce =
    typeof window !== 'undefined' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  if (l) return l.scrollTo(target, { duration: 1.3, offset })
  if (typeof target === 'number')
    return window.scrollTo({
      top: target,
      behavior: reduce ? 'auto' : 'smooth',
    })
  const el =
    typeof target === 'string' ? document.querySelector(target) : target
  el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' })
}
