import type { AccessKeyInfo } from './types'
import { config } from '@/config'

export class RpcError extends Error {}

const toBase64 = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))

// JSON-RPC over the configured endpoints, falling through to the next on network or 5xx failure.
async function rpc<T>(method: string, params: unknown): Promise<T> {
  let last: unknown
  for (const url of config.rpcUrls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'ss', method, params }),
      })
      if (res.status >= 500 || res.status === 429) {
        last = new RpcError(`RPC ${res.status}`)
        continue
      }
      const body = await res.json()
      if (body.error)
        throw new RpcError(
          body.error.cause?.name ?? body.error.message ?? 'RPC error',
        )
      if (body.result?.error) throw new RpcError(String(body.result.error))
      return body.result as T
    } catch (e) {
      if (e instanceof RpcError) throw e
      last = e
    }
  }
  throw last instanceof Error
    ? new RpcError(`NEAR RPC is unavailable: ${last.message}`)
    : new RpcError('NEAR RPC is unavailable')
}

export async function view<T>(
  method: string,
  args: object = {},
  contractId: string = config.shopId,
): Promise<T> {
  const r = await rpc<{ result: Array<number> }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: method,
    args_base64: toBase64(JSON.stringify(args)),
  })
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T
}

export async function viewAccessKeys(
  accountId: string = config.shopId,
): Promise<Array<AccessKeyInfo>> {
  const r = await rpc<{ keys: Array<AccessKeyInfo> }>('query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: accountId,
  })
  return r.keys
}

// Reads every page of a { from, limit } view; the contract caps limit at 100.
export async function viewAll<T>(
  method: string,
  total?: number,
): Promise<Array<T>> {
  const out: Array<T> = []
  for (;;) {
    const page = await view<Array<T>>(method, { from: out.length, limit: 100 })
    out.push(...page)
    if (page.length < 100 || (total !== undefined && out.length >= total))
      return out
  }
}

/** view_account: balance, storage and, for a NEP-591 vault, the global contract code hash it runs */
export async function viewAccount(accountId: string) {
  return rpc<{
    amount: string
    storage_usage: number
    code_hash: string
    global_contract_hash?: string | null
  }>('query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: accountId,
  })
}
