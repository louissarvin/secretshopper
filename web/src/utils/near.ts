// Display helpers for chain values

export const fmtUnits = (
  raw: string | number | bigint,
  decimals = 6,
  shown = 2,
) => {
  const s = BigInt(raw)
    .toString()
    .padStart(decimals + 1, '0')
  const n = Number(`${s.slice(0, -decimals)}.${s.slice(-decimals)}`)
  return n.toLocaleString('en-US', {
    minimumFractionDigits: shown,
    maximumFractionDigits: shown,
  })
}

export const parseUnits = (v: string, decimals = 6) => {
  const m = v.trim().match(/^(\d+)(?:\.(\d+))?$/)
  if (!m) return null
  // the optional group is undefined at runtime when there is no fraction
  const frac = String(m[2] || '')
  if (frac.length > decimals) return null
  return (
    BigInt(m[1]) * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, '0') || '0')
  ).toString()
}

export const yoctoToNear = (y: string, shown = 4) => fmtUnits(y, 24, shown)

export const short = (s: string | null | undefined, a = 6, b = 4) =>
  !s ? '' : s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s

export const ago = (ms: number, now = Date.now()) => {
  const s = Math.round((now - ms) / 1000)
  const a = Math.abs(s)
  const f =
    a < 60
      ? `${a}s`
      : a < 3600
        ? `${Math.round(a / 60)}m`
        : a < 86400
          ? `${Math.round(a / 3600)}h`
          : `${Math.round(a / 86400)}d`
  return s >= 0 ? `${f} ago` : `in ${f}`
}

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

export const utcStamp = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC'

export const ACCOUNT_RE =
  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
export const isAccountId = (a: string) =>
  a.length >= 2 && a.length <= 64 && ACCOUNT_RE.test(a)
export const ED25519_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/

const YOCTO_KEYS = new Set([
  'key_allowance',
  'min_near_float',
  'storage_deposit',
])
const TOKEN_KEYS = new Set(['daily_cap', 'max_per_payment'])
const NS_KEYS = /(_interval|_ttl|_grace|_cooldown|_delay|min_answer)$/

export const duration = (ns: string) => {
  const s = Number(BigInt(ns) / 10n ** 9n)
  if (s % 3600 === 0) return `${s / 3600} h`
  if (s % 60 === 0) return `${s / 60} min`
  return `${s} s`
}

/** A policy field in contract units (token base units, yoctoNEAR, ns), shown the way a person reads it. */
export function fmtPolicy(k: string, v: unknown, sym: string, dec: number) {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return String(v)
  if (YOCTO_KEYS.has(k)) return `${yoctoToNear(v, 4)} NEAR`
  if (TOKEN_KEYS.has(k)) return `${fmtUnits(v, dec)} ${sym}`
  if (NS_KEYS.test(k)) return duration(v)
  return v
}
