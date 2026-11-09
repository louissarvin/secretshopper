import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import CopyCmd from '@/components/CopyCmd'
import { useSession } from '@/hooks/useSession'
import { useCompaniesMine, useTesterPlan } from '@/hooks/useShop'
import { ApiError } from '@/lib/api/client'
import { ownerApi } from '@/lib/api/shop'
import { viewAccessKeys } from '@/lib/near/rpc'
import { signActions } from '@/lib/near/wallet'
import { testerKeyAction, testerKeyCli } from '@/lib/testerKey'
import { config } from '@/config'
import { short, yoctoToNear } from '@/utils/near'

// Plain words for the API's tester states and refusals (GET /public/tester in backend/API.md)
const STATE_TEXT: Record<string, string> = {
  provisioning:
    'The tester is preparing this vault’s key. It takes up to a minute.',
  key_missing: 'Add the tester key below.',
  key_scope: 'The key on chain has other permissions than the tester needs.',
  allowance_unlimited:
    'The key on chain has an unlimited allowance; add a bounded one.',
  allowance_low:
    'The tester key’s allowance is used up; add it again with a new allowance.',
  owner_changed: 'The vault owner changed since registration.',
  unarmed: 'The agent is not armed yet: the vendor has to accept its key.',
  no_vendors:
    'Add at least one vendor in the owner app so lures have someone to imitate.',
  policy_unsupported:
    'This vault’s batch size is larger than the tester supports.',
  low_float: 'The vault needs more free NEAR for reveals.',
  over_capacity: 'The tester is serving as many vaults as it can right now.',
  budget: 'The tester’s model budget is spent for now.',
}

// Refusals worth a plain sentence; anything else shows the API's own message
const CODE_TEXT: Record<string, string> = {
  VAULT_NOT_INDEXED:
    'The vault was just created and the API has not seen it yet. Try again in a few seconds.',
  VAULT_READS_BUSY: 'The API is busy reading the chain. Try again in a minute.',
  COMPANY_LIMIT: 'You have registered the most vaults one account may (5).',
  TESTER_FULL:
    'The tester is serving as many vaults as it can. Try again later.',
  DEFAULT_VAULT_ENV:
    "This deployment's own vault is tested from its server settings, not here.",
}

const errText = (e: unknown) =>
  e instanceof ApiError && CODE_TEXT[e.code]
    ? CODE_TEXT[e.code]
    : e instanceof ApiError
      ? `${e.message}${e.code && e.code !== 'HTTP' ? ` (${e.code})` : ''}`
      : e instanceof Error
        ? e.message
        : 'Something went wrong.'

/**
 * Registers a new vault with Secret Shopper and switches its covert tests on: sign in, register, add the tester's
 * function-call key (built and bounded here, see lib/testerKey.ts), enable. Each stage is read back before the next.
 */
export default function TesterSetup({
  vault,
  owner,
}: {
  vault: string
  owner: string
}) {
  const s = useSession()
  const qc = useQueryClient()
  const mine = useCompaniesMine()
  const company = mine.data?.items.find((c) => c.shopContractId === vault)
  const plan = useTesterPlan(company ? vault : undefined)
  const keys = useQuery({
    queryKey: ['chain', owner, 'keys'],
    enabled: !!plan.data?.publicKey,
    queryFn: () => viewAccessKeys(owner),
    refetchInterval: 15_000,
  })
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const signedInAsOwner = !!s.token && s.accountId === owner

  let key: ReturnType<typeof testerKeyAction> | null = null
  let keyErr: string | null = null
  if (plan.data?.publicKey)
    try {
      key = testerKeyAction(plan.data, vault, owner)
    } catch (e) {
      keyErr = errText(e)
    }
  const keyOnChain =
    !!key && !!keys.data?.some((k) => k.public_key === key.publicKey)

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what)
    setErr(null)
    try {
      await f()
      await qc.invalidateQueries({ queryKey: ['owner', 'mine'] })
      await qc.invalidateQueries({ queryKey: ['api', vault, 'tester'] })
      await qc.invalidateQueries({ queryKey: ['chain', owner, 'keys'] })
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <span className="label">Turn on covert tests</span>
      {!signedInAsOwner ? (
        <>
          <p className="dimt" style={{ fontSize: 14 }}>
            Sign in as {owner} so Secret Shopper can register the vault. It is a
            signed message, nothing on chain.
          </p>
          <div>
            <button
              className="btn ghost sm"
              type="button"
              onClick={s.signIn}
              disabled={s.step !== 'idle'}
            >
              {s.step !== 'idle' ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
          {s.error && <small className="sheet-err">{s.error}</small>}
        </>
      ) : mine.isError ? (
        <p className="sheet-err">{errText(mine.error)}</p>
      ) : !company ? (
        <div className="formgrid">
          <div className="field">
            <label htmlFor="ts-name">Company name</label>
            <input
              id="ts-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </div>
          <div className="full">
            <button
              className="btn ghost sm"
              type="button"
              disabled={!name.trim() || busy !== null}
              onClick={() =>
                run('register', () =>
                  ownerApi.registerVault(name.trim(), vault),
                )
              }
            >
              {busy === 'register' ? 'Registering…' : 'Register the vault'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="kv">
            <dt>registered as</dt>
            <dd>{company.name}</dd>
            <dt>tester</dt>
            <dd>
              {company.tester.enabled ? 'on' : 'off'}
              {plan.data?.state ? ` · ${plan.data.state}` : ''}
            </dd>
          </dl>
          {plan.data?.state && STATE_TEXT[plan.data.state] && (
            <p className="dimt" style={{ fontSize: 14 }}>
              {STATE_TEXT[plan.data.state]}
            </p>
          )}
          {keyErr && <p className="sheet-err">{keyErr}</p>}
          {key && !keyOnChain && (
            <div style={{ display: 'grid', gap: 8 }}>
              <span className="label">Tester key, checked here</span>
              <pre className="docpre">
                {`signer    ${owner}\nreceiver  ${owner}\naction    AddKey ${short(key.publicKey, 12, 6)}\ncan call  ${vault}: commit_batch, prove_delivery, release, reveal\nallowance ${yoctoToNear(key.allowanceYocto, 2)} NEAR for gas, then the key stops`}
              </pre>
              <div>
                <button
                  className="btn solid sm"
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    run('key', () => signActions(owner, owner, [key.action]))
                  }
                >
                  {busy === 'key'
                    ? 'Waiting for your wallet…'
                    : 'Add the tester key'}
                </button>
              </div>
              <CopyCmd cmd={testerKeyCli(key, config.network)} />
            </div>
          )}
          {keyOnChain && !company.tester.enabled && (
            <div>
              <button
                className="btn solid sm"
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  run('enable', () =>
                    ownerApi.setTester({ enabled: true }, vault),
                  )
                }
              >
                {busy === 'enable' ? 'Turning on…' : 'Turn on covert tests'}
              </button>
            </div>
          )}
          {company.tester.enabled && (
            <p className="dimt" style={{ fontSize: 14 }}>
              Covert tests are on. The agent needs its inbox token: issue it in
              the{' '}
              <Link className="txl" to="/app/agent">
                owner app
              </Link>
              .
            </p>
          )}
        </>
      )}
      {err && (
        <small className="sheet-err" role="alert">
          {err}
        </small>
      )}
      <span className="src">
        POST /company · GET /public/tester · PUT /company/tester
      </span>
    </div>
  )
}
