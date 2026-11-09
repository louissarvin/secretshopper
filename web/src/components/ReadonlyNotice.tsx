import { Link } from '@tanstack/react-router'
import { config } from '@/config'

/** Shown instead of sign-in on the hosted demo, whose API serves public routes only. */
export default function ReadonlyNotice({ who }: { who: string }) {
  return (
    <div className="gate">
      <div className="box">
        <span className="label">Hosted demo · read-only</span>
        <h1 className="disp">
          <span className="mline">
            <span>{who}</span>
          </span>
          <span className="mline">
            <span className="cob">runs locally.</span>
          </span>
        </h1>
        <p className="dimt">
          This hosted demo is read-only. Sign-in and the owner and vendor
          actions need the full API, which you run locally: see the README. The
          public scorecard, every test page, the ledger and the vault planner
          work here with live data.
        </p>
        <Link
          className="btn solid"
          to="/s/$shopId"
          params={{ shopId: config.shopId }}
        >
          Public scorecard <span className="arr">→</span>
        </Link>
        <Link className="btn ghost" to="/new">
          Create a vault
        </Link>
        <Link className="btn ghost" to="/">
          Back to the site
        </Link>
      </div>
    </div>
  )
}
