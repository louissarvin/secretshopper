import type { ConnectorAction } from '@hot-labs/near-connect'
import { ACCOUNT_RE } from '@/utils/near'

/** What the owner asked for in the form; the API's plan must match it exactly. */
export interface PlanIntent {
  owner: string
  name: string
  vendor: string
  token: string
  fundYocto: string
  codeHash: string
  /** Caps the owner typed, in token base units */
  caps: { daily_cap?: string; max_per_payment?: string }
  /** Most a blank cap may be, in token base units (from the token's decimals read over RPC) */
  capCeiling: string
  /** The token's storage_balance_bounds.min, read over RPC; the registration may not pay more */
  storageMinYocto: string
}

export interface CheckedPlan {
  vaultId: string
  totalYocto: string
  policy: Record<string, unknown>
  storageYocto: string
  transactions: Array<{ receiverId: string; actions: Array<ConnectorAction> }>
}

const NS_HOUR = 3_600_000_000_000n
const YOCTO = 10n ** 24n
const MAX_INIT_GAS = 300_000_000_000_000n
const UINT = /^\d{1,39}$/

const big = (v: unknown, what: string) => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
    return BigInt(v)
  if (typeof v !== 'string' || !UINT.test(v))
    throw new Error(`${what} is not an amount.`)
  return BigInt(v)
}

const sameKeys = (o: object, keys: Array<string>) => {
  const k = Object.keys(o).sort()
  return (
    k.length === keys.length && [...keys].sort().every((x, i) => x === k[i])
  )
}

/**
 * Bounds that protect the owner and the vendor whatever the API proposes: the payee and limit delays stop an owner
 * from framing the agent, the key funding and float stay inside the contract's own rules.
 */
function checkPolicy(
  p: Record<string, unknown>,
  caps: PlanIntent['caps'],
  ceiling: bigint,
) {
  const daily = big(p.daily_cap, 'daily_cap')
  const perPayment = big(p.max_per_payment, 'max_per_payment')
  if (caps.daily_cap && p.daily_cap !== caps.daily_cap)
    throw new Error('The daily cap is not the one you entered.')
  if (caps.max_per_payment && p.max_per_payment !== caps.max_per_payment)
    throw new Error('The per-payment cap is not the one you entered.')
  if (daily > ceiling && !caps.daily_cap)
    throw new Error(
      'The default daily cap is above the ceiling; enter the caps yourself.',
    )
  if (perPayment === 0n || perPayment > daily)
    throw new Error(
      'The per-payment cap must be positive and at most the daily cap.',
    )
  if (big(p.payee_delay, 'payee_delay') < NS_HOUR)
    throw new Error('New payees would go live in under an hour.')
  if (big(p.limits_delay, 'limits_delay') < NS_HOUR)
    throw new Error('Looser limits would apply in under an hour.')
  if (big(p.key_allowance, 'key_allowance') > YOCTO)
    throw new Error('The agent key would be funded with more than 1 NEAR.')
  if (big(p.min_near_float, 'min_near_float') < YOCTO / 10n)
    throw new Error('The vault NEAR float is below 0.1 NEAR.')
  const DAY = 24n * NS_HOUR
  const within = (k: string, lo: bigint, hi: bigint, why: string) => {
    const v = big(p[k], k)
    if (v < lo || v > hi) throw new Error(why)
  }
  within('rearm_cooldown', 0n, 7n * DAY, 'The re-arm cooldown is over 7 days.')
  within(
    'test_ttl',
    NS_HOUR,
    30n * DAY,
    'The test window is outside 1 hour to 30 days.',
  )
  within(
    'reveal_grace',
    9_000_000_000n,
    7n * DAY,
    'The reveal grace is outside 9 seconds to 7 days.',
  )
  within(
    'batch_interval',
    NS_HOUR,
    7n * DAY,
    'The batch interval is outside 1 hour to 7 days.',
  )
  within(
    'storage_deposit',
    0n,
    YOCTO / 10n,
    'The storage deposit is over 0.1 NEAR.',
  )
  for (const k of [
    'max_payments_per_day',
    'max_decisions_per_day',
    'batch_size',
  ])
    within(k, 1n, 10_000n, `${k} is out of range.`)
  within(
    'max_new_payees_per_day',
    0n,
    100n,
    'max_new_payees_per_day is out of range.',
  )
  const ttl = big(p.test_ttl, 'test_ttl')
  const answer = big(p.min_answer, 'min_answer')
  if (answer < ttl / 4n || answer >= ttl)
    throw new Error(
      'The answer time must be at least a quarter of the test window and below it.',
    )
  const lanes = p.key_nonces
  if (
    typeof lanes !== 'number' ||
    !Number.isInteger(lanes) ||
    lanes < 0 ||
    lanes > 64
  )
    throw new Error('The agent key lanes are out of range.')
  for (const [k, v] of Object.entries(p))
    if (typeof v !== 'number' && (typeof v !== 'string' || !UINT.test(v)))
      throw new Error(`Policy field ${k} is not a number.`)
}

/**
 * Checks a vault plan from the API action by action against the owner's own intent, so a hostile API cannot slip in
 * a key, a transfer, other code or another owner. Throws with a plain reason on any difference.
 */
export function checkPlan(
  plan: {
    signerId?: string
    transactions: Array<{ receiverId: string; actions: Array<ConnectorAction> }>
  },
  want: PlanIntent,
): CheckedPlan {
  const vaultId = `${want.name}.${want.owner}`
  for (const a of [want.owner, want.vendor, want.token])
    if (!ACCOUNT_RE.test(a)) throw new Error(`${a} is not a valid account.`)
  if (BigInt(want.storageMinYocto) > YOCTO / 10n)
    throw new Error('The token asks more than 0.1 NEAR to register the vault.')
  if (!ACCOUNT_RE.test(vaultId) || vaultId.length > 64)
    throw new Error('The vault name is not a valid account.')
  if (plan.signerId !== want.owner)
    throw new Error('The plan is signed by another account.')
  if (plan.transactions.length !== 2)
    throw new Error('The plan does not have exactly two transactions.')
  const [create, register] = plan.transactions

  if (create.receiverId !== vaultId)
    throw new Error(`The first transaction is not for ${vaultId}.`)
  const [a0, a1, a2, a3, ...rest] = create.actions as Array<
    ConnectorAction | undefined
  >
  if (rest.length || a0?.type !== 'CreateAccount')
    throw new Error(
      'The first transaction must start with CreateAccount and hold four actions.',
    )
  if (a1?.type !== 'Transfer' || a1.params.deposit !== want.fundYocto)
    throw new Error('The funding transfer is not the amount you entered.')
  if (
    a2?.type !== 'UseGlobalContract' ||
    !sameKeys(a2.params.contractIdentifier, ['codeHash']) ||
    !('codeHash' in a2.params.contractIdentifier) ||
    a2.params.contractIdentifier.codeHash !== want.codeHash
  )
    throw new Error('The vault would not run the audited contract code.')
  if (a3?.type !== 'FunctionCall' || a3.params.methodName !== 'new')
    throw new Error('The vault is not initialized with new.')
  if (a3.params.deposit !== '0' || big(a3.params.gas, 'gas') > MAX_INIT_GAS)
    throw new Error('The init call attaches a deposit or too much gas.')
  const init = a3.params.args as Record<string, unknown>
  if (
    !sameKeys(init, [
      'owner_id',
      'vendor_id',
      'token_id',
      'intents_id',
      'policy',
    ])
  )
    throw new Error('The init call carries unexpected fields.')
  if (init.owner_id !== want.owner)
    throw new Error('The vault owner is not you.')
  if (init.vendor_id !== want.vendor)
    throw new Error('The vendor is not the one you entered.')
  if (init.token_id !== want.token)
    throw new Error('The token is not the one you chose.')
  if (init.intents_id !== null)
    throw new Error('The plan turns on the Intents rail.')
  const policy = init.policy as Record<string, unknown> | null
  if (!policy || typeof policy !== 'object')
    throw new Error('The init call has no policy.')
  checkPolicy(policy, want.caps, BigInt(want.capCeiling))

  if (register.receiverId !== want.token)
    throw new Error('The second transaction is not for the token.')
  const [r0, ...more] = register.actions as Array<ConnectorAction | undefined>
  if (
    more.length ||
    r0?.type !== 'FunctionCall' ||
    r0.params.methodName !== 'storage_deposit'
  )
    throw new Error('The second transaction is not a token registration.')
  const reg = r0.params.args as Record<string, unknown>
  if (
    !sameKeys(reg, ['account_id', 'registration_only']) ||
    reg.account_id !== vaultId ||
    reg.registration_only !== true
  )
    throw new Error('The token registration is not for the new vault.')
  const storageYocto = big(r0.params.deposit, 'registration deposit')
  if (storageYocto > BigInt(want.storageMinYocto))
    throw new Error('The token registration pays more than the token asks.')
  if (big(r0.params.gas, 'gas') > MAX_INIT_GAS)
    throw new Error('The token registration attaches too much gas.')

  // The wallet gets transactions rebuilt from the checked values only, so no extra field from the API rides along
  const transactions: CheckedPlan['transactions'] = [
    {
      receiverId: vaultId,
      actions: [
        { type: 'CreateAccount' },
        { type: 'Transfer', params: { deposit: want.fundYocto } },
        {
          type: 'UseGlobalContract',
          params: { contractIdentifier: { codeHash: want.codeHash } },
        },
        {
          type: 'FunctionCall',
          params: {
            methodName: 'new',
            args: {
              owner_id: want.owner,
              vendor_id: want.vendor,
              token_id: want.token,
              intents_id: null,
              policy: { ...policy },
            },
            gas: String(big(a3.params.gas, 'gas')),
            deposit: '0',
          },
        },
      ],
    },
    {
      receiverId: want.token,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'storage_deposit',
            args: { account_id: vaultId, registration_only: true },
            gas: String(big(r0.params.gas, 'gas')),
            deposit: String(storageYocto),
          },
        },
      ],
    },
  ]
  return {
    vaultId,
    policy,
    storageYocto: String(storageYocto),
    totalYocto: String(BigInt(want.fundYocto) + storageYocto),
    transactions,
  }
}

/** NEAR CLI fallback built from the checked plan only; every value in it was validated above. */
export function planCli(p: CheckedPlan, want: PlanIntent, network: string) {
  const init = JSON.stringify({
    owner_id: want.owner,
    vendor_id: want.vendor,
    token_id: want.token,
    intents_id: null,
    policy: p.policy,
  })
  const reg = JSON.stringify({ account_id: p.vaultId, registration_only: true })
  // Single-quoted shell words: refuse anything that could close the quote
  if (
    init.includes("'") ||
    reg.includes("'") ||
    !/^(testnet|mainnet)$/.test(network)
  )
    throw new Error('The plan cannot be written as a safe command.')
  return [
    `near transaction construct-transaction ${want.owner} receiver-id ${p.vaultId} add-action create-account add-action transfer '${want.fundYocto} yoctonear' add-action use-global-contract use-global-hash ${want.codeHash} with-init-call new json-args '${init}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' skip network-config ${network} sign-with-keychain send`,
    `near contract call-function as-transaction ${want.token} storage_deposit json-args '${reg}' prepaid-gas '30 Tgas' attached-deposit '${p.storageYocto} yoctonear' sign-as ${want.owner} network-config ${network} sign-with-keychain send`,
  ]
}
