import { Link } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { useVaultTemplate } from '@/hooks/useShop'
import { config } from '@/config'
import { yoctoToNear } from '@/utils/near'

// Rounded up to 0.01 NEAR, so the figure shown always covers the minimum
const nearUp = (yocto: string) => {
  const step = 10n ** 22n
  return yoctoToNear(String(((BigInt(yocto) + step - 1n) / step) * step), 2)
}

/** The logo as three depth layers that tilt toward the pointer over the card. */
function TiltMark({ card }: { card: React.RefObject<HTMLDivElement | null> }) {
  const stage = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stage.current
    const area = card.current
    if (!el || !area) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const rx = gsap.quickTo(el, 'rotationX', { duration: 0.8, ease: 'power3' })
    const ry = gsap.quickTo(el, 'rotationY', { duration: 0.8, ease: 'power3' })
    const float = gsap.to(el, {
      y: -10,
      duration: 3.2,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
    })
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth
      const dy = (e.clientY - (r.top + r.height / 2)) / window.innerHeight
      ry(gsap.utils.clamp(-22, 22, dx * 50))
      rx(gsap.utils.clamp(-16, 16, -dy * 40))
    }
    const leave = () => (rx(0), ry(0))
    area.addEventListener('pointermove', move)
    area.addEventListener('pointerleave', leave)
    return () => {
      area.removeEventListener('pointermove', move)
      area.removeEventListener('pointerleave', leave)
      float.kill()
      gsap.set(el, { clearProps: 'transform' })
    }
  }, [card])

  return (
    <div className="st-mark" aria-hidden="true">
      <div className="st-stage" ref={stage}>
        <i className="ring" />
        <i className="shade" />
        <i className="logo" />
      </div>
    </div>
  )
}

/** The page's one call to action: create a vault. Everything else on the page is evidence for it. */
export default function StartCta() {
  const tpl = useVaultTemplate()
  const min = tpl.data ? nearUp(tpl.data.minFundingYocto) : null
  const card = useRef<HTMLDivElement>(null)

  return (
    <section className="start" id="start">
      <div className="wrap">
        <div className="st-card" ref={card}>
          <div className="st-l">
            <span className="label">Your agent, your vault</span>
            <h2 className="disp rv st-h">
              <span className="mline">
                <span>Find out</span>
              </span>
              <span className="mline">
                <span>before a</span>
              </span>
              <span className="mline">
                <span className="dimc">fraudster</span>
              </span>
              <span className="mline">
                <span className="dimc">does.</span>
              </span>
            </h2>
            <p className="st-lead">
              Put your payments agent behind a vault with your limits. Secret
              Shopper slips covert fake invoices into its inbox, and the
              contract scores every decision where anyone can check it.
            </p>
            <div className="st-acts">
              <Link className="btn on-paper magnet" to="/new">
                Create your vault <span className="arr">→</span>
              </Link>
              <Link
                className="st-link"
                to="/s/$shopId"
                params={{ shopId: config.shopId }}
              >
                or see a live scorecard first
              </Link>
            </div>
          </div>
          <TiltMark card={card} />
          <dl className="st-facts">
            <div>
              <dt>2</dt>
              <dd>wallet approvals create, fund and lock the vault</dd>
            </div>
            <div>
              <dt>{min ? `${min} NEAR` : '…'}</dt>
              <dd>
                to start on {config.network}, for storage, reveals and the agent
                key
              </dd>
            </div>
            <div>
              <dt>0</dt>
              <dd>keys that can change the vault's code, including yours</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  )
}
