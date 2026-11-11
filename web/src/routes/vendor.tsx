import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { VendorMe } from '@/lib/api/shop'
import type { Policy } from '@/lib/near/types'
import ActivityFeed from '@/components/ActivityFeed'
import CopyCmd from '@/components/CopyCmd'
import ReadonlyNotice from '@/components/ReadonlyNotice'
import SignInGate from '@/components/SignInGate'
import {
  ActiveVaultProvider,
  useActiveVault,
  useVaultSwitch,
} from '@/hooks/useActiveVault'
import { ErrorState, Skel } from '@/components/QueryState'
import { useFeedback } from '@/components/Feedback'
import { SourcesToggle } from '@/components/SiteNav'
import { useNow } from '@/hooks/useMotion'
import { useSession } from '@/hooks/useSession'
import {
  usePendingLimits,
  usePolicy,
  useStatus,
  useToken,
  useVendorHistory,
  useVendorMe,
  useVendorVaults,
} from '@/hooks/useShop'
import { ApiError } from '@/lib/api/client'
import { nsToMs } from '@/lib/near/types'
import {
  ED25519_RE,
  clock,
  fmtPolicy,
  isAccountId,
  short,
  utcStamp,
} from '@/utils/near'
import { ONE_YOCTO } from '@/lib/near/wallet'
import { config } from '@/config'

export const Route = createFileRoute('/vendor')({
  head: () => ({ meta: [{ title: 'Vendor console · Secret Shopper' }] }),
  component: VendorRoute,
})

// The API sends contract times as nanosecond strings and its own as ISO.
const toMs = (v: string | null) =>
  !v ? null : /^\d{16,}$/.test(v) ? nsToMs(v) : Date.parse(v)

/** Only values that passed these checks reach a shell command or a signature. */
const safeAccept = (vault: string, vendor: string, pk: string) =>
  isAccountId(vault) &&
  isAccountId(vendor) &&
  ED25519_RE.test(pk) &&
  /^(testnet|mainnet)$/.test(config.network)

function acceptCli(vault: string, vendor: string, pk: string) {
  return [
    `near contract call-function as-transaction ${vault} accept_key \\`,
    `  json-args '${JSON.stringify({ public_key: pk })}' \\`,
    `  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \\`,
    `  sign-as ${vendor} network-config ${config.network} \\`,
    `  sign-with-keychain send`,
  ].join('\n')
}

// Terms that let the owner treat the agent unfairly, flagged by the API
// Terms that weaken the vault's protection against an owner framing the agent
const FAIRNESS_WARNINGS: Record<string, string> = {
  payee_delay_under_1h:
    'Payee list changes take effect in under an hour. That leaves the owner little room for error, and room to change the list around a payment to frame the agent.',
  limits_delay_zero:
    'Looser limits take effect at once instead of after a wait.',
  min_answer_at_floor:
    'The agent gets the shortest answer time the contract allows. A test it receives but does not decide in time counts against it.',
}

// The policy fields that decide whether the owner can frame the agent, read from get_policy
const FAIRNESS_KEYS = [
  'payee_delay',
  'limits_delay',
  'min_answer',
  'test_ttl',
  'reveal_grace',
  'batch_size',
  'batch_interval',
  'rearm_cooldown',
] as const

const HOUR_NS = 3_600_000_000_000n

/** The same three checks the API makes, worked out here from the chain so the API cannot hide them. */
function fairnessWarnings(p: Policy) {
  const w: Array<keyof typeof FAIRNESS_WARNINGS> = []
  if (BigInt(p.payee_delay) < HOUR_NS) w.push('payee_delay_under_1h')
  if (BigInt(p.limits_delay) === 0n) w.push('limits_delay_zero')
  if (BigInt(p.min_answer) <= BigInt(p.test_ttl) / 4n)
    w.push('min_answer_at_floor')
  return w
}

function ArmPanel({ me }: { me: VendorMe }) {
  const vault = useActiveVault()
  const { confirmCall } = useFeedback()
  const now = useNow()
  const [mine, setMine] = useState(false)
  const coolEnd = toMs(me.cooldownEndsAt)
  const cooling = me.mode === 'Demoted' && !!coolEnd && now < coolEnd
  const armed = me.mode === 'Armed'
  const steps: Array<[string, string, boolean]> = [
    [
      'Cooldown',
      me.mode !== 'Demoted'
        ? 'Not needed'
        : cooling && coolEnd
          ? `Opens in ${clock(coolEnd - now)}`
          : 'Done',
      cooling,
    ],
    [
      'Owner proposes',
      me.pendingKey
        ? `Proposed ${short(me.pendingKey, 12, 6)}`
        : `propose_key by ${me.ownerId}`,
      !armed && !cooling && !me.pendingKey,
    ],
    ['You accept', 'accept_key, 1 yoctoNEAR', !!me.acceptKey],
    ['Armed', 'pay, decline, ack', armed],
  ]
  // Built here from the chain, not from the API's acceptKey: this site's vault and the key the owner proposed on it
  const chainStatus = useStatus(me.vault)
  const policy = usePolicy(vault)
  const pendingLimits = usePendingLimits(vault)
  const chainKey = chainStatus.data?.pending_key ?? null
  const sameVault = me.vault === vault
  const a =
    me.acceptKey &&
    sameVault &&
    chainKey &&
    chainKey === me.pendingKey &&
    safeAccept(me.vault, me.vendorId, chainKey)
      ? { publicKey: chainKey }
      : null
  const proposedAt = toMs(me.pendingKeyProposedAt)
  return (
    <div className="panel" style={{ display: 'grid', gap: 18 }}>
      <div className="ptop">
        <h3>Arm the agent</h3>
        <span className="src">GET /vendor/me · acceptKey</span>
      </div>
      <p className="dimt" style={{ fontSize: 14 }}>
        The agent can pay only with a key both sides agreed to. The owner
        proposes it, you accept the same key. A demoted agent waits out the
        cooldown first.
      </p>
      <div className="steps">
        {steps.map(([b, t, on], i) => (
          <div key={b} className={on ? 'now' : ''}>
            <span className="label" style={{ color: 'inherit', opacity: 0.7 }}>
              0{i + 1}
            </span>
            <b>{b}</b>
            <span>{t}</span>
          </div>
        ))}
      </div>
      {a ? (
        <>
          <dl className="kv">
            <dt>key to accept</dt>
            <dd>{a.publicKey}</dd>
            {proposedAt && (
              <>
                <dt>proposed</dt>
                <dd>{utcStamp(proposedAt)}</dd>
              </>
            )}
          </dl>
          {me.pendingKeyMatchesArmed === false && (
            <p className="sheet-err" role="alert">
              This is not a key this vault has armed before. That is expected
              the first time; otherwise accept it only if you rotated your
              agent's key yourself.
            </p>
          )}
          {policy.data ? (
            <>
              {fairnessWarnings(policy.data).map((w) => (
                <p key={w} className="sheet-err" role="alert">
                  {FAIRNESS_WARNINGS[w]}
                </p>
              ))}
              {pendingLimits.data && (
                <p className="sheet-err" role="alert">
                  The owner has looser limits waiting to apply on{' '}
                  {utcStamp(nsToMs(pendingLimits.data.effective_at))}.
                </p>
              )}
              <div style={{ display: 'grid', gap: 8 }}>
                <span className="label">
                  Terms you agree to by accepting, read from the vault
                </span>
                <dl className="kv">
                  {FAIRNESS_KEYS.map((k) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt>{k.replace(/_/g, ' ')}</dt>
                      <dd>{fmtPolicy(k, policy.data[k], '', 0)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          ) : (
            <Skel h={80} />
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
            />
            <span>
              I checked that {short(a.publicKey, 14, 6)} is my agent's public
              key.
            </span>
          </label>
          <div>
            <button
              className="btn solid magnet"
              type="button"
              disabled={!mine}
              onClick={() =>
                confirmCall({
                  title: 'Accept agent key',
                  receiverId: vault,
                  method: 'accept_key',
                  args: { public_key: a.publicKey },
                  tgas: config.gasTgas.default,
                  deposit: ONE_YOCTO,
                  note: 'The vault deletes the old agent key and adds this one with pay, decline and ack, under the terms shown on the page.',
                }).then((ok) => ok && setMine(false))
              }
            >
              Accept key
            </button>
          </div>
          {mine && (
            <div style={{ display: 'grid', gap: 8 }}>
              <span className="label">
                Wallet without this option? Run it with the NEAR CLI
              </span>
              <CopyCmd cmd={acceptCli(vault, me.vendorId, a.publicKey)} />
              <small className="dimt">
                Keys in ~/.near-credentials need sign-with-legacy-keychain.
              </small>
            </div>
          )}
        </>
      ) : (
        <p className="dimt" style={{ fontSize: 14 }}>
          {armed
            ? 'The agent is armed. Nothing to accept.'
            : me.pendingKey
              ? 'A key is proposed but cannot be accepted yet. A gas key needs free NEAR in the vault to fund it; ask the owner to top it up.'
              : 'Nothing to accept yet. The owner has to propose a key first.'}
        </p>
      )}
    </div>
  )
}

function Console({ me }: { me: VendorMe }) {
  const history = useVendorHistory(true)
  const status = useStatus(me.vault)
  const token = useToken(status.data?.token_id)
  const sc = me.scorecard
  const scored =
    sc.stats.passed +
    sc.stats.failed +
    sc.stats.failed_contained +
    sc.stats.ignored
  return (
    <>
      <ArmPanel me={me} />
      <div className="vcols">
        <div className="panel" style={{ display: 'grid', gap: 12 }}>
          <div className="ptop">
            <h3>Vault</h3>
            <span className="src">GET /vendor/me</span>
          </div>
          <dl className="kv">
            <dt>vault</dt>
            <dd>{me.vault}</dd>
            <dt>owner</dt>
            <dd>{me.ownerId}</dd>
            <dt>your record</dt>
            <dd>
              <Link
                className="txl"
                to="/agent/$vendorId"
                params={{ vendorId: me.vendorId }}
              >
                every vault you armed
              </Link>
            </dd>
            <dt>agent key</dt>
            <dd>{me.agentKey ? short(me.agentKey, 14, 6) : 'none'}</dd>
            {me.armedAt && (
              <>
                <dt>armed</dt>
                <dd>{utcStamp(toMs(me.armedAt)!)}</dd>
              </>
            )}
            {me.demotedAt && (
              <>
                <dt>demoted</dt>
                <dd>{utcStamp(toMs(me.demotedAt)!)}</dd>
              </>
            )}
            {me.staleKey && (
              <>
                <dt>stale key</dt>
                <dd>{short(me.staleKey, 14, 6)}</dd>
              </>
            )}
            {Object.entries(me.limits).map(([k, v]) => (
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
        </div>
        <div className="panel" style={{ display: 'grid', gap: 12 }}>
          <div className="ptop">
            <h3>Test record</h3>
            <Link
              className="btn ghost sm"
              to="/s/$shopId"
              params={{ shopId: me.vault }}
            >
              Public scorecard
            </Link>
          </div>
          <span className="vnum">
            {sc.score_bps === null ? '–' : (sc.score_bps / 100).toFixed(2)}
            <small>%</small>
          </span>
          <p className="dimt" style={{ fontSize: 14 }}>
            {sc.stats.passed} passed, {sc.stats.failed} failed,{' '}
            {sc.stats.ignored} ignored of {scored} scored. {sc.pending} sealed,{' '}
            {sc.stats.demotions} demotion
            {sc.stats.demotions === 1 ? '' : 's'}.
          </p>
        </div>
      </div>
      <ActivityFeed
        q={history}
        title="History"
        src="GET /vendor/history"
        empty="Arming, demotions and test reveals show up here."
      />
    </>
  )
}

function VendorConsole() {
  const s = useSession()
  const me = useVendorMe()
  const vaults = useVaultSwitch()
  const notVendor =
    me.error instanceof ApiError && me.error.status === 403 ? me.error : null
  if (config.readonlyDemo)
    return (
      <div className="pg-app">
        <ReadonlyNotice who="The vendor console" />
      </div>
    )
  if (!s.ready) return null
  const expired =
    me.error instanceof ApiError && me.error.status === 401 && !me.isFetching
  if (!s.token || expired)
    return (
      <div className="pg-app">
        <SignInGate s={s} who="Vendor" scope="the agent's co-signer" />
      </div>
    )
  return (
    <div className="pg-app pg-vendor">
      <main className="main">
        <div className="top">
          <div className="chips">
            <Link className="chip" to="/">
              Secret Shopper
            </Link>
            {vaults && vaults.owned.length > 1 ? (
              <select
                className="chip vsel"
                aria-label="Vault"
                value={vaults.vault}
                onChange={(e) => vaults.setVault(e.target.value)}
              >
                {vaults.owned.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              me.data && <span className="chip">{me.data.vault}</span>
            )}
            {me.data && (
              <span
                className={`chip${me.data.mode === 'Armed' ? '' : ' solid'}`}
              >
                {me.data.mode}
              </span>
            )}
            <span className="chip dash">{config.network}</span>
          </div>
          <div className="nav-r">
            <SourcesToggle />
            <span className="mono dimt" style={{ fontSize: 12.5 }}>
              {s.accountId}
            </span>
            <button className="btn ghost sm" type="button" onClick={s.signOut}>
              Sign out
            </button>
          </div>
        </div>
        <h1 className="disp vt">
          <span className="mline">
            <span>Vendor</span>
          </span>
        </h1>
        <section className="view vstack">
          {notVendor ? (
            <div className="state err" role="alert">
              <b>{s.accountId} is not this vault's agent vendor</b>
              <p>
                {notVendor.message} Sign in with the account set as vendor_id on
                the vault.
              </p>
              <button
                className="btn ghost sm"
                type="button"
                onClick={s.signOut}
              >
                Sign out
              </button>
            </div>
          ) : me.isError ? (
            <ErrorState
              what="the vendor console"
              error={me.error}
              retry={() => me.refetch()}
            />
          ) : !me.data ? (
            <Skel h={240} />
          ) : (
            <Console me={me.data} />
          )}
        </section>
      </main>
    </div>
  )
}

function VendorRoute() {
  // Vaults that name this vendor; this build's vault while the list loads or on an older API
  const list = useVendorVaults()
  const listed = list.data?.items.map((v) => v.shopContractId) ?? []
  return (
    <ActiveVaultProvider owned={listed.length ? listed : [config.shopId]}>
      <VendorConsole />
    </ActiveVaultProvider>
  )
}
