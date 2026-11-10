import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import SiteNav from '@/components/SiteNav'
import { config } from '@/config'

export const Route = createFileRoute('/devices')({
  head: () => ({ meta: [{ title: 'Device check · Secret Shopper' }] }),
  component: Devices,
})

const PAGES: Array<[string, string]> = [
  ['Home', '/'],
  ['Scorecard', `/s/${config.shopId}`],
  ['Dashboard', '/app'],
  ['Inbox', '/app/inbox'],
  ['Tests', '/app/tests'],
  ['Approvals', '/app/approvals'],
  ['Vendors', '/app/vendors'],
]
const SETS: Record<string, Array<[string, number, number]>> = {
  Phones: [
    ['iPhone SE', 375, 667],
    ['iPhone 15', 393, 852],
    ['Pixel 8', 412, 915],
    ['iPhone 15 Pro Max', 430, 932],
  ],
  'Small phones': [
    ['Galaxy Fold, folded', 344, 882],
    ['iPhone SE', 375, 667],
  ],
  Tablets: [
    ['iPad mini', 744, 1133],
    ['iPad Pro 11', 834, 1194],
  ],
  Desktop: [
    ['Laptop', 1280, 800],
    ['Desktop', 1440, 900],
  ],
}

type Report = {
  over: Array<string>
  small: Array<string>
  tiny: Array<string>
  hScroll: boolean
} | null

const nameOf = (el: Element) =>
  (
    el.tagName.toLowerCase() +
    (el.id ? `#${el.id}` : '') +
    (typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '')
  ).slice(0, 60)

// Same-origin frames, so the checker can read layout from inside each page.
function inspect(f: HTMLIFrameElement, mark: boolean): Report {
  const d = f.contentDocument
  const w = f.contentWindow
  if (!d?.body || !w) return null
  const vw = d.documentElement.clientWidth
  d.querySelectorAll<HTMLElement>('[data-ss-flag]').forEach(
    (el) => ((el.style.outline = ''), el.removeAttribute('data-ss-flag')),
  )
  const over: Array<Element> = []
  const small: Array<Element> = []
  const tiny: Array<Element> = []
  d.querySelectorAll('body *').forEach((el) => {
    const cs = w.getComputedStyle(el)
    if (
      cs.display === 'none' ||
      cs.visibility === 'hidden' ||
      el.closest(
        '[aria-hidden="true"], [inert], svg, canvas, .tbox, .vband, .ticker, .stage, .tcur, .drawer:not(.on), .sheet:not(.on)',
      )
    )
      return
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    if (r.right > vw + 1 && cs.position !== 'fixed') over.push(el)
    if (
      el.matches('a, button, input, select, textarea, [role="tab"]') &&
      (r.width < 43.5 || r.height < 43.5) &&
      !el.closest('p, li, td, dd')
    )
      small.push(el)
    if (
      [...el.childNodes].some(
        (n) => n.nodeType === 3 && n.textContent?.trim(),
      ) &&
      parseFloat(cs.fontSize) < 12
    )
      tiny.push(el)
  })
  if (mark) {
    over.forEach(
      (el) => (
        ((el as HTMLElement).style.outline = '2px solid #3A4CFF'),
        el.setAttribute('data-ss-flag', '')
      ),
    )
    small.forEach(
      (el) => (
        ((el as HTMLElement).style.outline = '2px dashed #3A4CFF'),
        el.setAttribute('data-ss-flag', '')
      ),
    )
    tiny.forEach(
      (el) => (
        ((el as HTMLElement).style.outline = '1px dotted #EBEAE6'),
        el.setAttribute('data-ss-flag', '')
      ),
    )
  }
  return {
    over: over.map(nameOf),
    small: small.map(nameOf),
    tiny: tiny.map(nameOf),
    hScroll: d.documentElement.scrollWidth > vw + 1,
  }
}

function Row({
  ok,
  okText,
  bad,
  list,
}: {
  ok: boolean
  okText: string
  bad: string
  list: Array<string>
}) {
  if (ok) return <span className="ok">{okText}</span>
  return (
    <details>
      <summary className="bad">{bad}</summary>
      <ul>
        {list.slice(0, 30).map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </details>
  )
}

function Frame({
  label,
  w,
  h,
  url,
  scale,
  kind,
  mark,
  run,
  onFrame,
}: {
  label: string
  w: number
  h: number
  url: string
  scale: number
  kind: string
  mark: boolean
  run: number
  onFrame: (f: HTMLIFrameElement | null) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [rep, setRep] = useState<Report>(null)
  const check = useCallback(
    () => ref.current && setRep(inspect(ref.current, mark)),
    [mark],
  )
  useEffect(() => {
    if (run) check()
  }, [run, check])
  useEffect(() => {
    onFrame(ref.current)
    return () => onFrame(null)
  }, [onFrame])
  return (
    <section className="dev">
      <header>
        <b>{label}</b>
        <span>
          {w} × {h}
        </span>
        <span>{Math.round(scale * 100)}%</span>
      </header>
      <div
        className={`shell ${kind}`}
        style={{ width: w * scale + 20, height: h * scale + 20 }}
      >
        <iframe
          ref={ref}
          title={`${label} preview`}
          src={url}
          style={{ width: w, height: h, transform: `scale(${scale})` }}
          onLoad={() => setTimeout(check, 3000)}
        />
      </div>
      <div className="report" aria-live="polite">
        {!rep ? (
          <span className="ok">Loading…</span>
        ) : (
          <>
            <Row
              ok={!rep.hScroll && !rep.over.length}
              okText="No horizontal overflow"
              bad={`${rep.hScroll ? 'Page scrolls sideways, ' : ''}${rep.over.length} element(s) past the edge`}
              list={rep.over}
            />
            <Row
              ok={!rep.small.length}
              okText="Tap targets 44 px or larger"
              bad={`${rep.small.length} tap target(s) under 44 px`}
              list={rep.small}
            />
            <Row
              ok={!rep.tiny.length}
              okText="No text under 12 px"
              bad={`${rep.tiny.length} element(s) with text under 12 px`}
              list={rep.tiny}
            />
          </>
        )}
      </div>
    </section>
  )
}

function Devices() {
  const [page, setPage] = useState(0)
  const [set, setSet] = useState('Phones')
  const [land, setLand] = useState(false)
  const [sync, setSync] = useState(true)
  const [mark, setMark] = useState(false)
  const [run, setRun] = useState(0)
  const [railW, setRailW] = useState(1200)
  const rail = useRef<HTMLDivElement>(null)
  const frames = useRef(new Set<HTMLIFrameElement>())

  useEffect(() => {
    const m = () => rail.current && setRailW(rail.current.clientWidth)
    m()
    window.addEventListener('resize', m)
    return () => window.removeEventListener('resize', m)
  }, [])

  // Scroll sync: scrolling one frame moves the others to the same relative position.
  const onFrame = useCallback(
    (f: HTMLIFrameElement | null) => {
      if (!f) return
      frames.current.add(f)
      let syncing = false
      const attach = () => {
        try {
          f.contentWindow?.addEventListener(
            'scroll',
            () => {
              if (!sync || syncing) return
              const de = f.contentDocument!.documentElement
              const ratio =
                f.contentWindow!.scrollY /
                Math.max(1, de.scrollHeight - f.contentWindow!.innerHeight)
              frames.current.forEach((o) => {
                if (o === f || !o.isConnected) return
                const od = o.contentDocument?.documentElement
                if (od) {
                  syncing = true
                  o.contentWindow!.scrollTo(
                    0,
                    ratio * (od.scrollHeight - o.contentWindow!.innerHeight),
                  )
                  requestAnimationFrame(() => (syncing = false))
                }
              })
            },
            { passive: true },
          )
        } catch {}
      }
      f.addEventListener('load', attach)
    },
    [sync],
  )

  const kind = set === 'Tablets' ? 'tab' : set === 'Desktop' ? 'desk' : ''
  const target =
    set === 'Desktop'
      ? Math.min(railW, 900)
      : set === 'Tablets'
        ? Math.min(railW, 520)
        : Math.min(railW, 360)

  return (
    <div className="pg-devices">
      <SiteNav />
      <div className="wrap head" style={{ paddingTop: 110 }}>
        <span className="label">
          Layout check · same pages, real device widths
        </span>
        <h1>
          Every page,
          <br />
          <span className="cob">every phone.</span>
        </h1>
        <p>
          Each frame loads the real page at the device's CSS width. Scrolling
          one frame scrolls the rest. Every frame checks for horizontal
          overflow, tap targets under 44 px and text under 12 px, and can
          outline what it finds. App pages show their sign-in step until this
          tab has a session.
        </p>
        <div className="ctrl">
          <div className="seg" role="group" aria-label="Page">
            {PAGES.map(([l], i) => (
              <button
                key={l}
                type="button"
                aria-pressed={i === page}
                onClick={() => setPage(i)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="ctrl">
          <div className="seg" role="group" aria-label="Devices">
            {Object.keys(SETS).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={k === set}
                onClick={() => setSet(k)}
              >
                {k}
              </button>
            ))}
          </div>
          <label className="tog">
            <input
              type="checkbox"
              checked={sync}
              onChange={(e) => setSync(e.target.checked)}
            />{' '}
            Sync scroll
          </label>
          <label className="tog">
            <input
              type="checkbox"
              checked={land}
              onChange={(e) => setLand(e.target.checked)}
            />{' '}
            Landscape
          </label>
          <label className="tog">
            <input
              type="checkbox"
              checked={mark}
              onChange={(e) => (
                setMark(e.target.checked),
                setRun((n) => n + 1)
              )}
            />{' '}
            Outline issues
          </label>
          <button
            className="btn ghost sm"
            type="button"
            onClick={() => setRun((n) => n + 1)}
          >
            Run checks again
          </button>
        </div>
      </div>
      <div className="wrap rail" ref={rail}>
        {SETS[set].map(([label, W, H]) => {
          const w = land ? H : W
          const h = land ? W : H
          const scale = Math.min(1, target / w, 820 / h)
          return (
            <Frame
              key={`${page}${set}${land}${label}`}
              label={label}
              w={w}
              h={h}
              url={PAGES[page][1]}
              scale={scale}
              kind={kind}
              mark={mark}
              run={run}
              onFrame={onFrame}
            />
          )
        })}
      </div>
    </div>
  )
}
