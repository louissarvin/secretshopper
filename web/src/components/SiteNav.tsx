import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { config } from '@/config'

// A file, not inline paths: the traced mark is 31 KB and stays out of the JS bundle
export function Mark() {
  return (
    <img
      className="mark-img"
      src="/logo.svg"
      width="34"
      height="34"
      alt=""
      decoding="async"
    />
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
