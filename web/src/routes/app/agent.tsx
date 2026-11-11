import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import CopyCmd from '@/components/CopyCmd'
import { useActiveVault } from '@/hooks/useActiveVault'
import { useCompaniesMine } from '@/hooks/useShop'
import { ApiError } from '@/lib/api/client'
import { ownerApi } from '@/lib/api/shop'
import { config } from '@/config'

export const Route = createFileRoute('/app/agent')({ component: Agent })

function Agent() {
  const vault = useActiveVault()
  const qc = useQueryClient()
  const mine = useCompaniesMine()
  const company = mine.data?.items.find((c) => c.shopContractId === vault)
  // Shown once and only held in this component: never stored, never logged
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sure, setSure] = useState(false)

  const issue = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await ownerApi.inboxToken(vault)
      if (r.shopContractId !== vault)
        throw new Error('The API issued a token for another vault.')
      setToken(r.token)
      setSure(false)
      await qc.invalidateQueries({ queryKey: ['owner', 'mine'] })
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? `${e.message} (${e.code})`
          : e instanceof Error
            ? e.message
            : 'The API did not issue a token.',
      )
    } finally {
      setBusy(false)
    }
  }

  const env = [
    `AGENT_VAULT_ID=${vault}`,
    `INBOX_URL=${config.apiUrl}/inbox`,
    `INBOX_TOKEN=${token ?? '<the token above>'}`,
    'AGENT_PRIVATE_KEY=<the agent key the vendor armed on this vault>',
  ].join('\n')

  return (
    <section className="view">
      <h1 className="disp vt">
        <span className="mline">
          <span>Agent</span>
        </span>
      </h1>
      <div className="panel" style={{ display: 'grid', gap: 14 }}>
        <div className="ptop">
          <h3>Inbox token</h3>
          <span className="src">POST /company/inbox-token</span>
        </div>
        <p className="dimt" style={{ fontSize: 14 }}>
          Your agent reads its invoices, real and covert, with this token. It
          only opens the inbox of {vault}, and the agent refuses a token for
          another vault. You see it once; issuing a new one stops the old one at
          once.
        </p>
        {company?.inboxTokenSet && !token && (
          <p className="dimt" style={{ fontSize: 14 }}>
            A token is already set for this vault.
          </p>
        )}
        {token ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="label">
              Copy it now: it will not be shown again
            </span>
            <CopyCmd cmd={token} />
          </div>
        ) : company?.inboxTokenSet && !sure ? (
          <label className="check">
            <input
              type="checkbox"
              checked={sure}
              onChange={(e) => setSure(e.target.checked)}
            />
            <span>
              Replace the current token. The running agent stops reading until
              it gets the new one.
            </span>
          </label>
        ) : null}
        {!token && (
          <div>
            <button
              className="btn solid sm"
              type="button"
              onClick={issue}
              disabled={busy || (!!company?.inboxTokenSet && !sure)}
            >
              {busy
                ? 'Issuing…'
                : company?.inboxTokenSet
                  ? 'Issue a new token'
                  : 'Issue the token'}
            </button>
          </div>
        )}
        {err && (
          <small className="sheet-err" role="alert">
            {err}
          </small>
        )}
      </div>
      <div
        className="panel"
        style={{ display: 'grid', gap: 12, marginTop: 12 }}
      >
        <h3>Run your agent with it</h3>
        <p className="dimt" style={{ fontSize: 14 }}>
          Put these in the agent&apos;s env file (agent/.env, or agent/.env.mcp
          for an MCP client). The agent checks at start that the token belongs
          to this vault.
        </p>
        <CopyCmd cmd={env} />
        <p className="dimt" style={{ fontSize: 14 }}>
          Then run <code>bun run start</code> in agent/, or connect Claude Code
          or another MCP client as shown on{' '}
          <Link className="txl" to="/agents">
            Bring your own agent
          </Link>
          .
        </p>
      </div>
    </section>
  )
}
