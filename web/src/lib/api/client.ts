import { config } from '@/config'

export interface FieldError {
  field: string
  message: string
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    /** Per-field messages on a 400, so forms can mark the right input */
    public fields: Array<FieldError> = [],
  ) {
    super(message)
  }
}

type Envelope<T> =
  | { success: true; error: null; data: T }
  | {
      success: false
      error: { code: string; message: string; fields?: Array<FieldError> }
      data: null
    }

let token: string | null = null
const TOKEN_KEY = 'ss-session'

// The JWT lives in memory and sessionStorage only, so it ends with the tab.
export const session = {
  get: () => {
    if (token) return token
    try {
      token = sessionStorage.getItem(TOKEN_KEY)
    } catch {}
    return token
  },
  set: (t: string | null) => {
    token = t
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t)
      else sessionStorage.removeItem(TOKEN_KEY)
    } catch {}
  },
}

/** The vault owner and vendor routes act on (X-Shop); empty means the deployment's default vault. */
export const activeShop = { value: '' }

type Query = Record<string, string | number | undefined | null>

export async function api<T>(
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'PUT'
    query?: Query
    body?: unknown
    auth?: boolean
    /** Vault for X-Shop, overriding the owner app's active vault */
    shop?: string
  } = {},
): Promise<T> {
  const url = new URL(config.apiUrl + path)
  for (const [k, v] of Object.entries(opts.query ?? {}))
    if (v !== undefined && v !== null && v !== '')
      url.searchParams.set(k, String(v))
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.auth) {
    const t = session.get()
    if (!t) throw new ApiError('UNAUTHORIZED', 'Sign in to continue.', 401)
    headers.Authorization = `Bearer ${t}`
    const shop = opts.shop ?? activeShop.value
    if (shop) headers['X-Shop'] = shop
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  } catch {
    throw new ApiError(
      'NETWORK',
      `Cannot reach the Secret Shopper API at ${config.apiUrl}.`,
      0,
    )
  }
  let env: Envelope<T>
  try {
    env = await res.json()
  } catch {
    throw new ApiError(
      'BAD_RESPONSE',
      `The API answered ${res.status} without JSON.`,
      res.status,
    )
  }
  if (!env.success) {
    if (res.status === 401 && opts.auth) session.set(null)
    throw new ApiError(
      env.error.code,
      env.error.message,
      res.status,
      env.error.fields ?? [],
    )
  }
  return env.data
}
