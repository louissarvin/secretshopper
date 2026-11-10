import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import type { RefObject } from 'react'

gsap.registerPlugin(ScrollTrigger, useGSAP)

/**
 * Entrance motion for a page section: `.rv` headings slide up line by line from their `.mline` masks,
 * `[data-stagger]` children rise in sequence. Content is in the DOM and readable before and without it.
 */
export function useReveal(
  scope: RefObject<HTMLElement | null>,
  deps: Array<unknown> = [],
) {
  useGSAP(
    () => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
      gsap.utils.toArray<HTMLElement>('.rv').forEach((h) => {
        if (h.dataset.done) return
        h.dataset.done = '1'
        gsap.from(h.querySelectorAll('.mline > span'), {
          yPercent: 105,
          duration: 1.05,
          ease: 'expo.out',
          stagger: 0.09,
          scrollTrigger: { trigger: h, start: 'top 92%', once: true },
        })
      })
      gsap.utils.toArray<HTMLElement>('[data-stagger]').forEach((g) => {
        if (g.dataset.done || !g.children.length) return
        g.dataset.done = '1'
        gsap.from(g.children, {
          y: 36,
          opacity: 0,
          duration: 0.9,
          ease: 'expo.out',
          stagger: 0.06,
          scrollTrigger: { trigger: g, start: 'top 94%', once: true },
        })
      })
      ScrollTrigger.refresh()
    },
    { scope, dependencies: deps },
  )
}
