import { Link } from '@tanstack/react-router'
import type { useSession } from '@/hooks/useSession'

const STEP_TEXT = [
  'Connect your NEAR wallet',
  'Ask the API for a one-time challenge',
  'Sign it in your wallet (NEP-413)',
  'Get a session for this tab',
] as const
const STEP_CODE = [
  'NEAR Connect',
  'POST /auth/nonce { accountId }',
  'message "Sign in to Secret Shopper", recipient = this site',
  'POST /auth/verify → JWT, 12 h',
] as const
const STEP_INDEX = {
  idle: -1,
  wallet: 0,
  challenge: 1,
  sign: 2,
  verify: 3,
} as const

/** NEP-413 sign-in screen shared by the owner app and the vendor console. */
export default function SignInGate({
  s,
  who,
  scope,
}: {
  s: ReturnType<typeof useSession>
  who: string
  scope: string
}) {
  const active: number = STEP_INDEX[s.step]
  return (
    <div className="gate">
      <div className="box">
        <span className="label">
          {who} sign-in · {scope}
        </span>
        <h1 className="disp">
          <span className="mline">
            <span>{who}</span>
          </span>
          <span className="mline">
            <span className="cob">sign-in.</span>
          </span>
        </h1>
        <p className="dimt">
          Sign a message with your NEAR wallet. Nothing is sent on chain and
          nothing is spent. The API checks the signature against a full-access
          key on your account.
        </p>
        <div className="gsteps">
          {STEP_TEXT.map((t, i) => (
            <div key={t} className={`gstep${i === active ? ' on' : ''}`}>
              <span className="n">0{i + 1}</span>
              <span>
                <b>{t}</b>
                <code>{STEP_CODE[i]}</code>
              </span>
            </div>
          ))}
        </div>
        {s.error && (
          <p className="sheet-err" role="alert">
            {s.error}
          </p>
        )}
        <button
          className="btn solid magnet"
          type="button"
          onClick={s.signIn}
          disabled={active >= 0}
        >
          {active >= 0 ? `${STEP_TEXT[active]}…` : 'Connect wallet and sign'}{' '}
          <span className="arr">→</span>
        </button>
        <Link className="btn ghost" to="/">
          Back to the site
        </Link>
      </div>
    </div>
  )
}
