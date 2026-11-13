import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import ScanlineWordmark from '@/components/elements/ScanlineWordmark'
import { useFeedback } from '@/components/Feedback'
import { useStatus } from '@/hooks/useShop'
import { scrollToTarget } from '@/lib/lenis'
import { config, explorerAccount } from '@/config'

const VERIFY_CMD = 'bun run setup && bun run verify'

const EVIDENCE = [
  'README.md',
  'backend/API.md',
  'backend/data/verify-report.json',
  'scripts/evidence',
]
export default function HomeFooter() {
  const { toast } = useFeedback()
  const status = useStatus(config.shopId)
  const [utc, setUtc] = useState('')
  useEffect(() => {
    const t = () => setUtc(new Date().toISOString().slice(11, 19))
    t()
    const id = setInterval(t, 1000)
    return () => clearInterval(id)
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(VERIFY_CMD)
      toast('Copied. Run it from the repository root.')
    } catch {
      toast(`Copy failed. The command is: ${VERIFY_CMD}`)
    }
  }

  return (
    <footer className="foot" id="foot">
      <div className="wrap">
        <div className="grid12 f-top">
          <div className="f-cta">
            <p className="label">Verify it yourself</p>
            <h2>
              Every claim, <span>one command.</span>
            </h2>
            <p className="f-sub">
              It builds the contract, runs every test and the end-to-end demo,
              and checks the build against the deployed code.
            </p>
            <div className="cmd">
              <code>
                <i>$</i> {VERIFY_CMD}
              </code>
              <button type="button" onClick={copy}>
                Copy
              </button>
            </div>
          </div>
          <nav className="f-cols" aria-label="Footer">
            <div>
              <span className="label">Pages</span>
              <Link to="/s/$shopId" params={{ shopId: config.shopId }}>
                Scorecard
              </Link>
              <Link to="/app">Owner app</Link>
              <Link to="/new">Create a vault</Link>
              <Link to="/agents">Bring your own agent</Link>
              <Link to="/vendor">Vendor console</Link>
              <Link to="/blocklist">Payee blocklist</Link>
              <a
                href="#drill"
                onClick={(e) => (
                  e.preventDefault(),
                  scrollToTarget('#drill', 0)
                )}
              >
                How it works
              </a>
              {import.meta.env.DEV && <Link to="/devices">Device check</Link>}
            </div>
            <div>
              <span className="label">Evidence</span>
              {EVIDENCE.map((f) =>
                config.repoUrl ? (
                  <a
                    key={f}
                    href={`${config.repoUrl}/blob/main/${f}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {f}
                  </a>
                ) : (
                  <span key={f}>{f}</span>
                ),
              )}
            </div>
            <div>
              <span className="label">Vault</span>
              <a
                href={explorerAccount(config.shopId)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {config.shopId}
              </a>
              <span>contract {status.data?.version ?? '…'}</span>
              <span>network {config.network}</span>
            </div>
          </nav>
        </div>
        <div className="f-status">
          <span className="pillstat">
            <i />
            {status.data
              ? `Vault live · ${status.data.mode}`
              : status.isError
                ? 'Vault unreachable right now'
                : 'Reading the vault…'}
          </span>
          <span>UTC {utc || '--:--:--'}</span>
        </div>
      </div>
      <div className="wrap f-mark">
        <ScanlineWordmark revealTrigger=".home main" />
      </div>
      <div className="wrap">
        <div className="f-bot">
          <span>
            © 2026 Secret Shopper · Built for the NEAR hackathon · the inbox and
            drill are illustrations
          </span>
          <button type="button" onClick={() => scrollToTarget(0)}>
            Back to top ↑
          </button>
        </div>
      </div>
    </footer>
  )
}
