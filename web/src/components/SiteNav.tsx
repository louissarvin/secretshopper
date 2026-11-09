import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { config } from '@/config'

export function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="18"
        height="18"
        rx="4"
        fill="none"
        stroke="#EBEAE6"
        strokeWidth="1.8"
      />
      <rect x="4.5" y="8.2" width="11" height="3.6" fill="#3A4CFF" />
    </svg>
  )
}

/** Shows which route or contract method each number comes from. Off by default. */
export function SourcesToggle() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    try {
      setOn(sessionStorage.getItem('ss-src') === '1')
    } catch {}
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('show-src', on)
    try {
      sessionStorage.setItem('ss-src', on ? '1' : '0')
    } catch {}
  }, [on])
  return (
    <button
      className="srcbtn"
      type="button"
      aria-pressed={on}
      onClick={() => setOn((v) => !v)}
    >
      Sources
    </button>
  )
}

interface Props {
  links?: React.ReactNode
  cta?: React.ReactNode
}

/** One floating bar; hides while scrolling down, returns on the way up. */
export default function SiteNav({ links, cta }: Props) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const st = ScrollTrigger.create({
      start: 0,
      end: 'max',
      onUpdate: (s) =>
        ref.current?.classList.toggle(
          'hide',
          s.direction === 1 && s.scroll() > 240,
        ),
    })
    return () => st.kill()
  }, [])
  return (
    <header className="nav" ref={ref}>
      <div className="wrap">
        <div className="bar">
          <Link className="brand" to="/">
            <Mark />
            Secret Shopper
          </Link>
          <nav className="links" aria-label="Pages">
            {links ?? (
              <>
                <Link
                  to="/s/$shopId"
                  params={{ shopId: config.shopId }}
                  activeOptions={{ exact: true }}
                >
                  Scorecard
                </Link>
                <Link to="/new">Create a vault</Link>
                <Link to="/agents">Your agent</Link>
                <Link to="/blocklist">Blocklist</Link>
                <Link to="/app">App</Link>
              </>
            )}
          </nav>
          <div className="nav-r">
            <SourcesToggle />
            {cta ?? (
              <Link className="btn solid sm magnet" to="/app">
                Open app <span className="arr">→</span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
