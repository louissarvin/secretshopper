import { Link } from '@tanstack/react-router'
import { useVaultTemplate } from '@/hooks/useShop'
import { config } from '@/config'
import { yoctoToNear } from '@/utils/near'

// Rounded up to 0.01 NEAR, so the figure shown always covers the minimum
const nearUp = (yocto: string) => {
  const step = 10n ** 22n
  return yoctoToNear(String(((BigInt(yocto) + step - 1n) / step) * step), 2)
}

/** The page's one call to action: create a vault. Everything else on the page is evidence for it. */
export default function StartCta() {
  const tpl = useVaultTemplate()
  const min = tpl.data ? nearUp(tpl.data.minFundingYocto) : null

  return (
    <section className="paper start" id="start">
      <div className="wrap grid12 st-grid">
        <div className="st-l">
          <span className="label">Your agent, your vault</span>
          <h2 className="disp rv">
            <span className="mline">
              <span>Find out</span>
            </span>
            <span className="mline">
              <span className="cob">before a</span>
            </span>
            <span className="mline">
              <span className="cob">fraudster does.</span>
            </span>
          </h2>
          <p className="st-lead">
            Put your payments agent behind a vault with your limits. Secret
            Shopper slips covert fake invoices into its inbox, and the contract
            scores every decision where anyone can check it.
          </p>
          <div className="st-acts">
            <Link className="btn solid magnet" to="/new">
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
        <div className="st-r" aria-hidden="true">
          <img src="/logo.svg" alt="" width="360" height="360" />
        </div>
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
    </section>
  )
}
