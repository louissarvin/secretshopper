// Browser copies of backend/src/lib/proof/{commitment,canonical,merkle,accessKeys}.ts.
// They must byte-match the contract; tests check them against backend/test/fixtures.

export const ZERO32 = '0'.repeat(64)
const HEX32 = /^[0-9a-f]{64}$/

export const hexToBytes = (h: string) =>
  Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)))
export const bytesToHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const concat = (...parts: Array<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const sha256 = async (b: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))
export const sha256Text = async (s: string) =>
  bytesToHex(await sha256(new TextEncoder().encode(s)))

/** v2: sha256(salt32 || u8 len(payee) || payee utf8 || invoice_id32 || receipt_hash32), lowercase hex. */
export async function commitmentOf(
  salt: string,
  payee: string,
  invoiceId: string,
  receiptHash: string,
) {
  for (const v of [salt, invoiceId, receiptHash])
    if (!HEX32.test(v)) throw new Error('expected 64 lowercase hex chars')
  const p = new TextEncoder().encode(payee)
  if (p.length > 64) throw new Error('payee longer than 64 bytes')
  return bytesToHex(
    await sha256(
      concat(
        hexToBytes(salt),
        Uint8Array.of(p.length),
        p,
        hexToBytes(invoiceId),
        hexToBytes(receiptHash),
      ),
    ),
  )
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v

export const canonicalJson = (doc: unknown) => JSON.stringify(sortKeys(doc))
export const invoiceIdOf = (doc: unknown) => sha256Text(canonicalJson(doc))

// Release tree, the same in the contract and backend: leaf = sha256(0x00 || id), node = sha256(0x01 || l || r), ids sorted, zero-padded to 2^depth.
const leaf = (id: string) => sha256(concat(Uint8Array.of(0), hexToBytes(id)))
const node = (l: Uint8Array, r: Uint8Array) =>
  sha256(concat(Uint8Array.of(1), l, r))

export async function merkleTree(ids: Array<string>) {
  const sorted = [...ids].sort()
  const depth = Math.ceil(Math.log2(Math.max(sorted.length, 1)))
  let level: Array<Uint8Array> = await Promise.all(sorted.map(leaf))
  while (level.length < 2 ** depth) level.push(new Uint8Array(32))
  const levels = [level]
  while (level.length > 1) {
    const next: Array<Uint8Array> = []
    for (let i = 0; i < level.length; i += 2)
      next.push(await node(level[i], level[i + 1]))
    levels.push((level = next))
  }
  const proofFor = (id: string) => {
    let index = sorted.indexOf(id)
    if (index < 0) return null
    const at = index
    const proof = levels.slice(0, -1).map((lv) => {
      const sib = lv[index ^ 1]
      index >>= 1
      return bytesToHex(sib)
    })
    return { index: at, proof }
  }
  return {
    root: bytesToHex(levels[levels.length - 1][0]),
    sorted,
    depth,
    proofFor,
  }
}

export async function rootFromProof(
  id: string,
  index: number,
  proof: Array<string>,
) {
  let h = await leaf(id)
  for (let d = 0; d < proof.length; d++) {
    const sib = hexToBytes(proof[d])
    h = (index >> d) & 1 ? await node(sib, h) : await node(h, sib)
  }
  return bytesToHex(h)
}

// Access key permission parsing, including NEP-611 gas keys
export type KeyScope =
  | { kind: 'full'; gasKey: boolean }
  | {
      kind: 'function'
      gasKey: boolean
      receiver: string
      methods: Array<string>
      lanes?: number
      balance?: string
    }
  | { kind: 'unknown' }

/** Unknown or malformed permissions are `unknown`, so callers fail closed. */
export function keyScope(permission: unknown): KeyScope {
  if (permission === 'FullAccess') return { kind: 'full', gasKey: false }
  if (!permission || typeof permission !== 'object') return { kind: 'unknown' }
  const p = permission as Record<string, any>
  if (Object.keys(p).length !== 1) return { kind: 'unknown' }
  if ('GasKeyFullAccess' in p) return { kind: 'full', gasKey: true }
  const fc = p.FunctionCall ?? p.GasKeyFunctionCall
  if (
    !fc ||
    typeof fc.receiver_id !== 'string' ||
    !Array.isArray(fc.method_names) ||
    !fc.method_names.every((m: unknown) => typeof m === 'string')
  )
    return { kind: 'unknown' }
  return {
    kind: 'function',
    gasKey: 'GasKeyFunctionCall' in p,
    receiver: fc.receiver_id,
    methods: fc.method_names,
    lanes: fc.num_nonces,
    balance: fc.balance,
  }
}

const AGENT_METHOD_SETS = new Set([
  'ack,decline,pay',
  'ack,decline,propose',
  'decline,pay',
  'decline,propose',
])
export const isVaultAgentScope = (s: KeyScope, vaultId: string) =>
  s.kind === 'function' &&
  s.receiver === vaultId &&
  AGENT_METHOD_SETS.has([...s.methods].sort().join(','))
