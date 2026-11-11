import {
  Link,
  Outlet,
  createFileRoute,
  useRouterState,
} from '@tanstack/react-router'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { Mark, SourcesToggle } from '@/components/SiteNav'
import { ErrorState, Skel } from '@/components/QueryState'
import ReadonlyNotice from '@/components/ReadonlyNotice'
import SignInGate from '@/components/SignInGate'
import {
  ActiveVaultProvider,
  useActiveVault,
  useVaultSwitch,
} from '@/hooks/useActiveVault'
import {
  useCompaniesMine,
  useCompany,
  useProposals,
  useStatus,
} from '@/hooks/useShop'
import { useSession } from '@/hooks/useSession'
import { ApiError } from '@/lib/api/client'
import { ownerApi } from '@/lib/api/shop'
import { config } from '@/config'

export const Route = createFileRoute('/app')({
  head: () => ({ meta: [{ title: 'Owner app · Secret Shopper' }] }),
  component: AppLayout,
})

type Session = ReturnType<typeof useSession>
const SessionContext = createContext<Session | null>(null)
export const useAppSession = () => useContext(SessionContext)!

const ICONS = {
  agent: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4M9 13h.01M15 13h.01M9 17h6" />
    </svg>
  ),
  dashboard: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  inbox: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M3 13h5l2 3h4l2-3h5" />
      <path d="M5 5h14l2 8v6H3v-6z" />
    </svg>
  ),
  tests: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  approvals: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M5 12l4 4 10-10" />
    </svg>
  ),
  vendors: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M21 20c0-2.6-1.6-4.8-4-5.6" />
    </svg>
  ),
}

function RegisterCompany() {
  const vault = useActiveVault()
  const [name, setName] = useState('')
  const [block, setBlock] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const company = useCompany()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setErr('Add your company name.')
    if (!/^[1-9]\d{0,15}$/.test(block))
      return setErr(
        'Enter the block height the vault was deployed at, as a whole number.',
      )
    try {
      await ownerApi.registerCompany(name.trim(), block)
      await company.refetch()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Registration failed.')
    }
  }
  return (
    <form
      className="panel"
      onSubmit={submit}
      style={{ display: 'grid', gap: 14, maxWidth: 560 }}
    >
      <h3>Register this vault</h3>
      <p className="dimt" style={{ fontSize: 14 }}>
        The API has no company for {vault} yet. Only the vault's on-chain owner
        can register it.
      </p>
      <div className="field">
        <label htmlFor="co-name">Company name</label>
        <input
          id="co-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </div>
      <div className="field">
        <label htmlFor="co-block">Vault deploy block</label>
        <input
          id="co-block"
          inputMode="numeric"
          value={block}
          onChange={(e) => setBlock(e.target.value.trim())}
        />
        <small>The indexer starts reading the vault from this block.</small>
      </div>
      {err && <small className="sheet-err">{err}</small>}
      <button className="btn solid" type="submit">
        Register
      </button>
    </form>
  )
}

function AppShell() {
  const vault = useActiveVault()
  const vaults = useVaultSwitch()
  const s = useSession()
  const pathname = useRouterState({ select: (r) => r.location.pathname })
  const status = useStatus(vault)
  const company = useCompany()
  const pending = useProposals('Pending')
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  useGSAP(
    () => {
      // the sign-in gate and notices render without the app shell, so there is nothing to animate
      if (!main.current || !main.current.querySelector('.vt')) return
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
      gsap.fromTo(
        '.vt .mline > span',
        { yPercent: 105 },
        { yPercent: 0, duration: 0.9, ease: 'expo.out' },
      )
      gsap.fromTo(
        '.view > *:not(.vt)',
        { y: 28, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.8, ease: 'expo.out', stagger: 0.06 },
      )
    },
    {
      scope: main,
      dependencies: [pathname, !!company.data],
      revertOnUpdate: true,
    },
  )

  if (config.readonlyDemo)
    return (
      <div className="pg-app">
        <ReadonlyNotice who="The owner app" />
      </div>
    )
  if (!s.ready) return null
  if (!s.token)
    return (
      <div className="pg-app">
        <SignInGate s={s} who="Owner" scope={vault} />
      </div>
    )

  const unauthorized =
    company.error instanceof ApiError &&
    company.error.status === 401 &&
    !company.isFetching
  if (unauthorized)
    return (
      <div className="pg-app">
        <SignInGate s={s} who="Owner" scope={vault} />
      </div>
    )
  const forbidden =
    company.error instanceof ApiError && company.error.status === 403
  const pendingCount = pending.data?.items.length ?? 0
  const tabs = [
    ['/app', 'Dashboard', ICONS.dashboard],
    ['/app/inbox', 'Inbox', ICONS.inbox],
    ['/app/tests', 'Tests', ICONS.tests],
    ['/app/approvals', 'Approvals', ICONS.approvals],
    ['/app/vendors', 'Vendors', ICONS.vendors],
    ['/app/agent', 'Agent', ICONS.agent],
  ] as const

  return (
    <SessionContext.Provider value={s}>
      <div className="pg-app">
        <div className="shell">
          <aside className="side" aria-label="App">
            <Link className="brand" to="/">
              <Mark />
              Secret Shopper
            </Link>
            <nav className="tabs">
              {tabs.map(([to, label, icon]) => (
                <Link
                  key={to}
                  to={to}
                  activeOptions={{ exact: true }}
                  activeProps={{ 'aria-current': 'page' }}
                >
                  {icon}
                  {label}
                  {to === '/app/approvals' && pendingCount > 0 && (
                    <span className="badge">{pendingCount}</span>
                  )}
                </Link>
              ))}
            </nav>
            <div className="who">
              <span>signed in as</span>
              <b>{s.accountId}</b>
              <span>vault</span>
              <b>{vault}</b>
              <button className="x" type="button" onClick={s.signOut}>
                Sign out
              </button>
            </div>
          </aside>
          <main className="main" ref={main}>
            <div className="top">
              <div className="chips">
                {vaults && vaults.owned.length > 1 ? (
                  <select
                    className="chip vsel"
                    aria-label="Vault"
                    value={vault}
                    onChange={(e) => vaults.setVault(e.target.value)}
                  >
                    {vaults.owned.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="chip">{vault}</span>
                )}
                {status.data && (
                  <span
                    className={`chip${status.data.mode === 'Armed' ? '' : ' solid'}`}
                  >
                    {status.data.mode}
                  </span>
                )}
                <span className="chip dash">{config.network}</span>
              </div>
              <div className="nav-r">
                <SourcesToggle />
                <Link
                  className="btn ghost sm"
                  to="/s/$shopId"
                  params={{ shopId: vault }}
                >
                  Public scorecard
                </Link>
                <button
                  className="btn ghost sm so"
                  type="button"
                  onClick={s.signOut}
                >
                  Sign out
                </button>
              </div>
            </div>
            {!status.data ? (
              status.isError ? (
                <ErrorState
                  what="the vault status"
                  error={status.error}
                  retry={() => status.refetch()}
                />
              ) : (
                <Skel h={160} />
              )
            ) : s.accountId !== status.data.owner_id ? (
              // A null /company/me only means "unregistered" for the on-chain owner
              <div className="state err" role="alert">
                <b>
                  {s.accountId === status.data.vendor_id
                    ? "You're signed in as the agent vendor"
                    : `${s.accountId} is not this vault's owner`}
                </b>
                <p>
                  The owner app is for {status.data.owner_id}.{' '}
                  {s.accountId === status.data.vendor_id
                    ? 'The vendor accepts agent keys in the vendor console.'
                    : 'Sign out and sign in with the owner account.'}
                </p>
                <div className="acts" style={{ display: 'flex', gap: 8 }}>
                  {s.accountId === status.data.vendor_id && (
                    <Link className="btn solid sm" to="/vendor">
                      Vendor console
                    </Link>
                  )}
                  <button
                    className="btn ghost sm"
                    type="button"
                    onClick={s.signOut}
                  >
                    Sign out
                  </button>
                </div>
              </div>
            ) : forbidden ? (
              <ErrorState
                what="the owner app"
                error={
                  new Error(
                    `${s.accountId} is not the owner of ${vault}. Sign in with the owner account.`,
                  )
                }
              />
            ) : company.isError ? (
              <ErrorState
                what="your company"
                error={company.error}
                retry={() => company.refetch()}
              />
            ) : company.isPending ? (
              <Skel h={160} />
            ) : company.data === null ? (
              <RegisterCompany />
            ) : (
              <Outlet />
            )}
          </main>
        </div>
      </div>
    </SessionContext.Provider>
  )
}

function AppLayout() {
  // The vaults this owner registered; this build's vault while the list is loading or on an older API
  const mine = useCompaniesMine()
  const listed = mine.data?.items.map((c) => c.shopContractId) ?? []
  const owned = listed.length ? listed : [config.shopId]
  return (
    <ActiveVaultProvider owned={owned}>
      <AppShell />
    </ActiveVaultProvider>
  )
}
