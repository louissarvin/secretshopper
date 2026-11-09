import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'

const HEX = '0123456789abcdef'

export const scrambleAt = (target: string, p: number) => {
  const n = Math.floor(p * target.length)
  let s = target.slice(0, n)
  for (let i = n; i < target.length; i++)
    s += /\s/.test(target[i]) ? target[i] : HEX[(Math.random() * 16) | 0]
  return s
}

interface Props {
  text: string
  duration?: number
  /** Changing the key replays the effect */
  replayKey?: unknown
  className?: string
}

/** Decrypted Text: resolves left to right out of hex noise whenever the text or replayKey changes. */
export default function DecryptedText({
  text,
  duration = 0.9,
  replayKey,
  className,
}: Props) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = text
      return
    }
    const o = { p: 0 }
    const tw = gsap.to(o, {
      p: 1,
      duration,
      ease: 'none',
      onUpdate: () => void (el.textContent = scrambleAt(text, o.p)),
      onComplete: () => void (el.textContent = text),
    })
    return () => void tw.kill()
  }, [text, duration, replayKey])

  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  )
}
