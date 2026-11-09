import { ApiError } from '@/lib/api/client'
import { config } from '@/config'

interface Props {
  error?: unknown
  what: string
  retry?: () => void
}

/** Explains a failed read in plain words and says how to fix it. */
export function ErrorState({ error, what, retry }: Props) {
  const e = error as any
  let hint = e?.message ?? 'Unknown error.'
  if (e instanceof ApiError && e.code === 'NETWORK')
    hint = `${e.message} Start the backend, set VITE_API_URL, or add ${typeof location === 'undefined' ? 'this site' : location.origin} to the API's CORS_ORIGINS.`
  else if (e instanceof ApiError && e.message === 'Route not found')
    hint = `The API at ${config.apiUrl} does not serve this route yet. Restart it on the latest backend.`
  else if (e instanceof ApiError && e.status === 404)
    hint = `${e.message} The API serves only vaults registered in its database.`
  else if (e instanceof ApiError && e.code === 'VAULT_READS_BUSY')
    hint =
      'The API has used its chain reads for this minute. Try again in a minute.'
  else if (e instanceof ApiError && e.status === 429)
    hint = 'Too many requests. Wait a minute and try again.'
  else if (/RPC/.test(hint))
    hint = `${hint} Check VITE_NEAR_RPC_URLS for ${config.network}.`
  return (
    <div className="state err" role="alert">
      <b>Could not load {what}</b>
      <p>{hint}</p>
      {retry && (
        <button className="btn ghost sm" type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  )
}

export function EmptyState({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="state">
      <b>{title}</b>
      {children && <p>{children}</p>}
    </div>
  )
}

export function Skel({
  h = 18,
  w = '100%',
}: {
  h?: number
  w?: number | string
}) {
  return (
    <span className="skel" style={{ height: h, width: w }} aria-hidden="true" />
  )
}
