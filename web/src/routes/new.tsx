import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VaultPlan } from '@/lib/api/shop'
import type { CheckedPlan, PlanIntent } from '@/lib/vaultPlan'
import { checkPlan, planCli } from '@/lib/vaultPlan'
import { view, viewAccount } from '@/lib/near/rpc'
import CopyCmd from '@/components/CopyCmd'
import Onboard from '@/components/Onboard'
import MiniFooter from '@/components/MiniFooter'
import SiteNav from '@/components/SiteNav'
import { ErrorState, Skel } from '@/components/QueryState'
import {
  useAccessKeys,
  useStatus,
  useToken,
  useVault,
  useVaultTemplate,
} from '@/hooks/useShop'
import { ApiError } from '@/lib/api/client'
import { publicApi } from '@/lib/api/shop'
import { keyScope } from '@/lib/near/proofs'
import { connectWallet, connectedAccount, sendPlan } from '@/lib/near/wallet'
import { config, explorerAccount, explorerTx } from '@/config'
import {
  fmtPolicy,
  fmtUnits,
  isAccountId,
  parseUnits,
  short,
  yoctoToNear,
} from '@/utils/near'

export const Route = createFileRoute('/new')({
  head: () => ({ meta: [{ title: 'Create a vault · Secret Shopper' }] }),
  validateSearch: (s: Record<string, unknown>): { vault?: string } =>
    typeof s.vault === 'string' ? { vault: s.vault } : {},
  component: NewVault,
})

// API field names for the form inputs
const FIELD_OF: Record<string, string> = {
  fundNear: 'fund',
  'policy.daily_cap': 'dailyCap',
  'policy.max_per_payment': 'perPayment',
}

// One label under the owner's account, as NEAR allows for a subaccount
const LABEL_RE = /^[a-z\d]+([-_][a-z\d]+)*$/

const failureOf = (outcome: any): string | null => {
  const s = outcome?.status
  return s && typeof s === 'object' && 'Failure' in s
    ? JSON.stringify(s.Failure).slice(0, 200)
    : null
}

// Rounded up, so typing the shown minimum always passes
const STEP = 10n ** 20n
const minNear = (y: string) =>
  yoctoToNear(String(((BigInt(y) + STEP - 1n) / STEP) * STEP), 4)

// Notes use `code` spans; render them without trusting any markup.
const withCode = (n: string) =>
  n.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))

function Template() {
  const t = useVaultTemplate()
  const token = useToken(config.defaultTokenId)
  if (t.isError)
    return (
      <ErrorState
        what="the vault template"
        error={t.error}
        retry={() => t.refetch()}
      />
    )
  if (!t.data) return <Skel h={160} />
  const d = t.data
  return (
    <div className="panel" style={{ display: 'grid', gap: 12 }}>
      <div className="ptop">
        <h3>What you get</h3>
        <span className="src">GET /public/vault-template</span>
      </div>
      <p className="dimt" style={{ fontSize: 14 }}>
        A vault that runs the same published contract as every other Secret
        Shopper vault, by code hash, so anyone can check it is the audited code.
        It is created, given that code and initialized in one transaction, and
        holds no full-access key.
      </p>
      <dl className="kv">
        <dt>network</dt>
        <dd>{d.network}</dd>
        <dt>code hash</dt>
        <dd>{config.vaultCodeHash}</dd>
        <dt>token</dt>
        <dd>{config.defaultTokenId}</dd>
        <dt>min funding</dt>
        <dd>{minNear(d.minFundingYocto)} NEAR</dd>
        {Object.entries(d.defaultPolicy).map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd>
              {fmtPolicy(
                k,
                v,
                token.data?.symbol ?? '',
                token.data?.decimals ?? 6,
              )}
            </dd>
          </div>
        ))}
      </dl>
      {d.notes.length > 0 && (
        <ul className="notes">
          {d.notes.map((n) => (
            <li key={n}>{withCode(n)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Live state of a vault on the published code, straight from the API's chain reads. */
function VaultLive({
  vaultId,
  next,
}: {
  vaultId: string
  next?: Array<string>
}) {
  const [poll, setPoll] = useState(true)
  const v = useVault(vaultId, poll)
  useEffect(() => {
    if (v.data) setPoll(false)
  }, [v.data])
  const e = v.error instanceof ApiError ? v.error : null
  // Owner, vendor, code and keys are read from the chain, so the API cannot vouch for a vault it built itself
  const live = !!v.data
  const acct = useQuery({
    queryKey: ['chain', vaultId, 'account'],
    enabled: live,
    queryFn: () => viewAccount(vaultId),
  })
  const st = useStatus(vaultId)
  const keys = useAccessKeys(vaultId)
  const fullAccess = keys.data
    ? keys.data.filter((k) => keyScope(k.access_key.permission).kind === 'full')
        .length
    : null
  const code = acct.data
    ? (acct.data.global_contract_hash ?? acct.data.code_hash)
    : null
  const audited = code === config.vaultCodeHash
  return (
    <div className="panel" style={{ display: 'grid', gap: 12 }}>
      <div className="ptop">
        <h3>{vaultId}</h3>
        <span className="src">GET /public/vault/:shopId</span>
      </div>
      {e?.status === 404 ? (
        <p className="dimt" style={{ fontSize: 14 }}>
          No account with this name yet. A vault that was just sent shows up
          within a few seconds.
        </p>
      ) : e?.status === 422 ? (
        <div className="state err" role="alert">
          <b>Not a Secret Shopper vault</b>
          <p>{e.message}</p>
        </div>
      ) : v.isError ? (
        <ErrorState
          what="this vault"
          error={v.error}
          retry={() => v.refetch()}
        />
      ) : !v.data || fullAccess === null ? (
        <Skel h={120} />
      ) : (
        <>
          {(fullAccess > 0 || v.data.keySummary?.truncated) && (
            <p className="sheet-err" role="alert">
              {fullAccess > 0
                ? `This vault has ${fullAccess} full-access key${fullAccess === 1 ? '' : 's'}. Whoever holds it can take the money, so the vault's rules do not bind it.`
                : 'The vault has more keys than the API lists. Check them all with view_access_key_list before trusting it.'}
            </p>
          )}
          {code && !audited && (
            <p className="sheet-err" role="alert">
              This account does not run the audited vault code. Its code hash is{' '}
              {code}; the audited build is {config.vaultCodeHash}.
            </p>
          )}
          <dl className="kv">
            <dt>code, from chain</dt>
            <dd>
              {code ?? '…'}
              {audited ? ' · audited build' : ''}
            </dd>
            <dt>owner</dt>
            <dd>{st.data?.owner_id ?? '…'}</dd>
            <dt>vendor</dt>
            <dd>{st.data?.vendor_id ?? '…'}</dd>
            <dt>mode</dt>
            <dd>{st.data?.mode ?? v.data.status?.mode ?? 'not initialized'}</dd>
            <dt>full-access keys</dt>
            <dd>{fullAccess}</dd>
            <dt>keys</dt>
            <dd>{keys.data?.length ?? '…'}</dd>
            <dt>tester</dt>
            <dd>{v.data.registered ? 'registered' : 'not set up yet'}</dd>
            {v.data.createdTx && (
              <>
                <dt>created</dt>
                <dd>
                  <a
                    className="txl"
                    href={explorerTx(v.data.createdTx)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(v.data.createdTx, 8, 6)}
                  </a>
                </dd>
              </>
            )}
          </dl>
          {/* Setup steps only for a vault the chain shows is the audited code with no full-access key */}
          {st.data && audited && fullAccess === 0 && (
            <Onboard vaultId={vaultId} />
          )}
          {!v.data.registered && (
            <div style={{ display: 'grid', gap: 8 }}>
              <span className="label">Then</span>
              <ol className="notes">
                {(next?.length
                  ? next
                  : [
                      'Arm the agent: you propose its key, the vendor accepts it.',
                      'Register the vault with a tester so lures start arriving.',
                    ]
                ).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ol>
            </div>
          )}
          <div className="acts">
            <a
              className="btn ghost sm"
              href={explorerAccount(vaultId)}
              target="_blank"
              rel="noreferrer"
            >
              Explorer
            </a>
            {v.data.registered && (
              <Link
                className="btn ghost sm"
                to="/s/$shopId"
                params={{ shopId: vaultId }}
              >
                Public scorecard
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Create({
  onCreated,
}: {
  onCreated: (id: string, next: Array<string>) => void
}) {
  const t = useVaultTemplate()
  const [owner, setOwner] = useState<string | null>(null)
  const [f, setF] = useState({
    name: '',
    vendorId: '',
    tokenId: '',
    fund: '',
    dailyCap: '',
    perPayment: '',
  })
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)
  const [plan, setPlan] = useState<VaultPlan | null>(null)
  // What is signed and shown comes from here: the API's plan after checkPlan, with client-built CLI commands
  const [checked, setChecked] = useState<{
    p: CheckedPlan
    cli: Array<string>
  } | null>(null)
  const [busy, setBusy] = useState<'plan' | 'sign' | null>(null)
  const [hashes, setHashes] = useState<Array<string>>([])
  const [taken, setTaken] = useState<string | null>(null)

  useEffect(() => {
    connectedAccount().then((a) => setOwner(a?.accountId ?? null))
  }, [])

  const set =
    (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
      setF((v) => ({ ...v, [k]: e.target.value }))
      setPlan(null)
      setChecked(null)
    }
  const connect = async () => {
    setErr(null)
    try {
      setOwner((await connectWallet()).accountId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The wallet did not connect.')
    }
  }

  const tokenId = f.tokenId.trim() || config.defaultTokenId
  const token = useToken(isAccountId(tokenId) ? tokenId : undefined)
  const sym = token.data?.symbol ?? 'tokens'
  // The template's caps are for 6 decimals; show them only when they apply as is
  const defaultCap = (k: 'daily_cap' | 'max_per_payment') => {
    const raw = t.data?.defaultPolicy[k]
    return typeof raw === 'string' && token.data?.decimals === 6
      ? fmtUnits(raw, 6)
      : ''
  }
  const planCaps = (
    [
      ['daily_cap', 'daily cap'],
      ['max_per_payment', 'max per payment'],
    ] as const
  ).filter(([k]) => checked?.p.policy[k] !== undefined)
  const vaultId = owner && f.name ? `${f.name.trim()}.${owner}` : null

  const makePlan = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!owner || !t.data) return
    const v: Record<string, string> = {}
    if (!LABEL_RE.test(f.name.trim()))
      v.name = 'Lowercase letters, digits, and - or _ between them.'
    else if (vaultId && vaultId.length > 64)
      v.name = 'The full vault name must be 64 characters or fewer.'
    if (!isAccountId(f.vendorId.trim()))
      v.vendorId = 'Enter the NEAR account of your agent vendor.'
    else if (f.vendorId.trim() === owner)
      v.vendorId = 'The vendor must be another account than the owner.'
    if (f.tokenId.trim() && !isAccountId(f.tokenId.trim()))
      v.tokenId = 'Enter a token contract account.'
    const fund = parseUnits(f.fund, 24)
    if (!fund || BigInt(fund) < BigInt(t.data.minFundingYocto))
      v.fund = `At least ${minNear(t.data.minFundingYocto)} NEAR.`
    // Caps go to the contract in the token's base units, from its own decimals
    const dec = token.data?.decimals
    const cap = (k: 'dailyCap' | 'perPayment') => {
      if (!f[k].trim()) return undefined
      const raw = dec === undefined ? null : parseUnits(f[k], dec)
      if (!raw || BigInt(raw) === 0n)
        v[k] =
          dec === undefined
            ? 'Could not read the token decimals.'
            : `A positive amount with at most ${dec} decimals.`
      return raw ?? undefined
    }
    const policy = {
      daily_cap: cap('dailyCap'),
      max_per_payment: cap('perPayment'),
    }
    // A blank daily cap means the template default, which is set for 6 decimals
    const daily6 = t.data.defaultPolicy.daily_cap
    if (policy.max_per_payment && dec !== undefined) {
      const per = BigInt(policy.max_per_payment)
      if (policy.daily_cap && per > BigInt(policy.daily_cap))
        v.perPayment = 'At most the daily cap.'
      else if (
        !policy.daily_cap &&
        typeof daily6 === 'string' &&
        per * 10n ** 6n > BigInt(daily6) * 10n ** BigInt(dec)
      )
        v.perPayment = `At most the daily cap, ${fmtUnits(daily6, 6)} ${sym} by default. Raise the daily cap too.`
    }
    setErrs(v)
    setErr(null)
    setTaken(null)
    if (Object.keys(v).length) return
    setBusy('plan')
    setPlan(null)
    setChecked(null)
    try {
      const tokenUsed = f.tokenId.trim() || config.defaultTokenId
      // Caps and their display use the token's own decimals, read over RPC
      if (!token.data) throw new Error('Could not read the token decimals yet.')
      const p = await publicApi.vaultPlan({
        ownerId: owner,
        name: f.name.trim(),
        vendorId: f.vendorId.trim(),
        tokenId: f.tokenId.trim() || undefined,
        fundNear: f.fund.trim(),
        policy:
          policy.daily_cap || policy.max_per_payment
            ? Object.fromEntries(
                Object.entries(policy).filter(
                  (e3): e3 is [string, string] => e3[1] !== undefined,
                ),
              )
            : undefined,
      })
      // The token sets what registering the vault may cost; read it from the chain, not the API
      const bounds = await view<{ min: string }>(
        'storage_balance_bounds',
        {},
        tokenUsed,
      )
      const intent: PlanIntent = {
        owner,
        name: f.name.trim(),
        vendor: f.vendorId.trim(),
        token: tokenUsed,
        fundYocto: fund!,
        codeHash: config.vaultCodeHash,
        caps: {
          daily_cap: policy.daily_cap,
          max_per_payment: policy.max_per_payment,
        },
        storageMinYocto: bounds.min,
        // a blank cap may be at most 10,000 whole tokens
        capCeiling: String(10_000n * 10n ** BigInt(token.data.decimals)),
      }
      try {
        const c = checkPlan(p, intent)
        setChecked({ p: c, cli: planCli(c, intent, config.network) })
        setPlan(p)
      } catch (bad) {
        setErr(
          `The API's plan does not match what you asked for, so nothing will be signed: ${bad instanceof Error ? bad.message : 'unknown difference'}`,
        )
      }
    } catch (e2) {
      if (e2 instanceof ApiError && e2.fields.length)
        setErrs(
          Object.fromEntries(
            e2.fields.map((x) => [FIELD_OF[x.field] ?? x.field, x.message]),
          ),
        )
      if (e2 instanceof ApiError && e2.status === 409) setTaken(vaultId)
      setErr(
        e2 instanceof ApiError && e2.code === 'VAULT_READS_BUSY'
          ? 'The API is busy reading the chain. Try again in a minute.'
          : e2 instanceof Error
            ? e2.message
            : 'The API could not plan it.',
      )
    } finally {
      setBusy(null)
    }
  }

  const sign = async () => {
    if (!plan || !checked || !owner) return
    setBusy('sign')
    setErr(null)
    try {
      const outcomes = await sendPlan({
        signerId: owner,
        transactions: checked.p.transactions,
      })
      const failed = outcomes.map(failureOf).find(Boolean)
      setHashes(outcomes.map((o: any) => o?.transaction?.hash).filter(Boolean))
      if (failed) throw new Error(`The chain rejected it: ${failed}`)
      onCreated(checked.p.vaultId, plan.next)
    } catch (e) {
      setErr(
        e instanceof Error ? e.message : 'The wallet did not send the plan.',
      )
    } finally {
      setBusy(null)
    }
  }

  const field = (
    k: keyof typeof f,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement>,
    hint?: string,
  ) => (
    <div className="field">
      <label htmlFor={`nv-${k}`}>{label}</label>
      <input
        id={`nv-${k}`}
        value={f[k]}
        onChange={set(k)}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!errs[k]}
        aria-describedby={`nv-${k}-hint`}
        {...props}
      />
      <small id={`nv-${k}-hint`} className={errs[k] ? 'err' : ''}>
        {errs[k] ?? hint}
      </small>
    </div>
  )

  return (
    <div className="panel" style={{ display: 'grid', gap: 16 }}>
      <div className="ptop">
        <h3>Create it</h3>
        <span className="src">POST /public/vault-plan</span>
      </div>
      <div className="acts" style={{ alignItems: 'center' }}>
        {owner ? (
          <>
            <span className="chip">owner {owner}</span>
            <button className="btn ghost sm" type="button" onClick={connect}>
              Switch account
            </button>
          </>
        ) : (
          <button className="btn solid" type="button" onClick={connect}>
            Connect the owner wallet
          </button>
        )}
      </div>
      <form className="formgrid" onSubmit={makePlan} noValidate>
        {field(
          'name',
          'Vault name',
          { placeholder: 'shop', maxLength: 40 },
          vaultId ? `The vault will be ${vaultId}` : 'A subaccount of yours.',
        )}
        {field(
          'vendorId',
          'Agent vendor account',
          { placeholder: 'vendor.testnet' },
          'Co-signs every agent key. Use an account you do not control alone.',
        )}
        {field(
          'tokenId',
          'Token (optional)',
          { placeholder: config.defaultTokenId },
          `The agent pays in ${tokenId || 'the default token'}.`,
        )}
        {field(
          'fund',
          'Fund with NEAR',
          { inputMode: 'decimal', placeholder: '2' },
          'Pays for storage, the reveal float and the agent gas key.',
        )}
        {field(
          'dailyCap',
          `Daily cap, ${sym} (optional)`,
          { inputMode: 'decimal', placeholder: defaultCap('daily_cap') },
          'Most the agent can pay in any 24 hours.',
        )}
        {field(
          'perPayment',
          `Max per payment, ${sym} (optional)`,
          { inputMode: 'decimal', placeholder: defaultCap('max_per_payment') },
          'Most the agent can pay in one invoice.',
        )}
        <div className="full">
          <button
            className="btn solid magnet"
            type="submit"
            disabled={!owner || !t.data || !t.data.planEnabled || busy !== null}
          >
            {busy === 'plan' ? 'Planning…' : 'Review the transaction'}
          </button>
        </div>
      </form>
      {t.data && !t.data.planEnabled && (
        <p className="sheet-err" role="alert">
          This API has vault planning turned off
          {t.data.codePublished
            ? ''
            : ': the contract code is not published yet'}
          .
        </p>
      )}
      {err && (
        <p className="sheet-err" role="alert">
          {err}{' '}
          {taken && (
            <button
              className="btn ghost sm"
              type="button"
              onClick={() => onCreated(taken, [])}
            >
              Check {taken}
            </button>
          )}
        </p>
      )}
      {plan && (
        <div style={{ display: 'grid', gap: 14 }}>
          {plan.warnings?.map((w) => (
            <p key={w} className="sheet-err">
              {w}
            </p>
          ))}
          <span className="label">You sign, in this order</span>
          <ol className="plan">
            {checked?.p.transactions.map((tx, i) => (
              <li key={i}>
                <b>{tx.receiverId}</b>
                <code>{tx.actions.map((a) => describe(a)).join(' · ')}</code>
                {hashes[i] && (
                  <a
                    className="txl"
                    href={explorerTx(hashes[i])}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(hashes[i], 8, 6)}
                  </a>
                )}
              </li>
            ))}
          </ol>
          <dl className="kv">
            <dt>vault</dt>
            <dd>{checked?.p.vaultId}</dd>
            <dt>total</dt>
            <dd>
              {checked ? yoctoToNear(checked.p.totalYocto, 4) : '…'} NEAR plus
              gas, computed here from the actions
            </dd>
            {planCaps.map(([k, label]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{label}</dt>
                <dd>
                  {fmtPolicy(
                    k,
                    checked?.p.policy[k],
                    token.data?.symbol ?? '',
                    token.data?.decimals ?? 0,
                  )}
                </dd>
              </div>
            ))}
            <dt>signer</dt>
            <dd>{owner}</dd>
          </dl>
          <div>
            <button
              className="btn solid magnet"
              type="button"
              onClick={sign}
              disabled={busy !== null || !token.data}
            >
              {busy === 'sign'
                ? 'Waiting for your wallet…'
                : 'Open wallet and sign'}
            </button>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="label">
              Wallet cannot sign UseGlobalContract? Run these with the NEAR CLI
            </span>
            {checked?.cli.map((c) => (
              <CopyCmd key={c} cmd={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const describe = (a: VaultPlan['transactions'][number]['actions'][number]) => {
  switch (a.type) {
    case 'Transfer':
      return `Transfer ${yoctoToNear(a.params.deposit, 4)} NEAR`
    case 'UseGlobalContract':
      return 'codeHash' in a.params.contractIdentifier
        ? `UseGlobalContract ${short(a.params.contractIdentifier.codeHash, 6, 4)}`
        : `UseGlobalContract ${a.params.contractIdentifier.accountId}`
    case 'FunctionCall':
      return `${a.params.methodName}()${a.params.deposit !== '0' ? ` + ${yoctoToNear(a.params.deposit, 4)} NEAR` : ''}`
    default:
      return a.type
  }
}

function NewVault() {
  const { vault } = Route.useSearch()
  const navigate = useNavigate({ from: '/new' })
  const [plannedNext, setPlannedNext] = useState<Array<string>>()
  const [lookup, setLookup] = useState('')
  const open = (id: string, next?: Array<string>) => {
    setPlannedNext(next)
    navigate({ search: { vault: id } })
  }
  return (
    <div className="pg-new">
      <SiteNav />
      <main>
        <section className="wrap phero">
          <div className="crumbs">
            <span className="label">Self-serve</span>
            <span className="chip dash">{config.network}</span>
          </div>
          <h1 className="disp">
            <span className="mline">
              <span>Create your</span>
            </span>
            <span className="mline">
              <span className="cob">vault.</span>
            </span>
          </h1>
          <p className="dimt" style={{ maxWidth: '60ch' }}>
            One wallet transaction gives your company its own Secret Shopper
            vault. The money sits in the contract, the agent gets a key that can
            only pay inside your limits, and the vault grades every decision.
          </p>
        </section>
        <section className="wrap nv-grid">
          <div className="nv-l">
            <Create onCreated={open} />
          </div>
          <div className="nv-r">
            {vault && <VaultLive vaultId={vault} next={plannedNext} />}
            <Template />
            <form
              className="panel"
              style={{ display: 'grid', gap: 12 }}
              onSubmit={(e) => {
                e.preventDefault()
                if (isAccountId(lookup.trim())) open(lookup.trim())
              }}
            >
              <h3>Check a vault</h3>
              <div className="field">
                <label htmlFor="nv-lookup">Vault account</label>
                <input
                  id="nv-lookup"
                  value={lookup}
                  onChange={(e) => setLookup(e.target.value)}
                  placeholder={config.shopId}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div>
                <button className="btn ghost sm" type="submit">
                  Check
                </button>
              </div>
            </form>
          </div>
        </section>
      </main>
      <MiniFooter note="Every vault runs the same published code, checked by its hash" />
    </div>
  )
}
