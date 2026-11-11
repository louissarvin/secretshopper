import type { ConnectorAction } from '@hot-labs/near-connect'
import type { TesterPlan } from '@/lib/api/shop'
import { ACCOUNT_RE, ED25519_RE } from '@/utils/near'

// The only methods a tester key may call (GET /public/tester in backend/API.md), sorted; pinned here, never taken from the API
export const TESTER_METHODS = [
  'commit_batch',
  'prove_delivery',
  'release',
  'reveal',
] as const

const YOCTO = 10n ** 24n
const MIN_ALLOWANCE = YOCTO / 10n
const MAX_ALLOWANCE = YOCTO

export interface TesterKey {
  owner: string
  vault: string
  publicKey: string
  allowanceYocto: string
  action: ConnectorAction
}

/**
 * The owner's AddKey for this vault's tester, built here from the API's plan after checking it: a function-call
 * key on the owner's account that can only call the four tester methods on this vault, with a finite allowance of
 * 0.1 to 1 NEAR. The public key itself is the API's; at worst it can spend that allowance on those methods.
 */
export function testerKeyAction(
  plan: TesterPlan,
  vault: string,
  owner: string,
): TesterKey {
  if (!ACCOUNT_RE.test(vault) || !ACCOUNT_RE.test(owner))
    throw new Error('The vault or owner is not a valid account.')
  if (plan.shopId !== vault || plan.receiverId !== vault)
    throw new Error('The tester plan is for another vault.')
  if (plan.signerId !== owner)
    throw new Error('The tester plan names another owner.')
  if (!plan.publicKey || !ED25519_RE.test(plan.publicKey))
    throw new Error('The tester key is not ready yet.')
  const methods = [...plan.methods].sort()
  if (
    methods.length !== TESTER_METHODS.length ||
    methods.some((m, i) => m !== TESTER_METHODS[i])
  )
    throw new Error('The tester key asks for other methods.')
  if (!/^\d{1,30}$/.test(plan.allowanceYocto))
    throw new Error('The tester allowance is not an amount.')
  const asked = BigInt(plan.allowanceYocto)
  const allowance =
    asked < MIN_ALLOWANCE
      ? MIN_ALLOWANCE
      : asked > MAX_ALLOWANCE
        ? MAX_ALLOWANCE
        : asked
  return {
    owner,
    vault,
    publicKey: plan.publicKey,
    allowanceYocto: String(allowance),
    action: {
      type: 'AddKey',
      params: {
        publicKey: plan.publicKey,
        accessKey: {
          permission: {
            receiverId: vault,
            allowance: String(allowance),
            methodNames: [...TESTER_METHODS],
          },
        },
      },
    },
  }
}

/** The same key as a NEAR CLI command; every value in it was checked above. */
export function testerKeyCli(k: TesterKey, network: string) {
  if (!/^(testnet|mainnet)$/.test(network)) throw new Error('Unknown network.')
  const near = `${(Number(BigInt(k.allowanceYocto) / 10n ** 20n) / 10_000).toString()} NEAR`
  return [
    `near account add-key ${k.owner} grant-function-call-access \\`,
    `  --allowance '${near}' --contract-account-id ${k.vault} \\`,
    `  --function-names '${TESTER_METHODS.join(', ')}' \\`,
    `  use-manually-provided-public-key ${k.publicKey} \\`,
    `  network-config ${network} sign-with-keychain send`,
  ].join('\n')
}
