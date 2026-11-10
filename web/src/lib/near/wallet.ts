import type {
  ConnectorAction,
  NearConnector,
  NearWalletBase,
} from '@hot-labs/near-connect'
import { config } from '@/config'

// NEAR Connect runs only in the browser; it is loaded on first use so SSR never touches it.
let connector: Promise<NearConnector> | null = null

export function getConnector() {
  if (typeof window === 'undefined') throw new Error('Wallet is browser only')
  connector ??= import('@hot-labs/near-connect').then(
    ({ NearConnector }) =>
      new NearConnector({
        network: config.network,
        features: { signMessage: true, signAndSendTransaction: true },
        footerBranding: null,
      }),
  )
  return connector
}

export async function connectedAccount(): Promise<{
  wallet: NearWalletBase
  accountId: string
} | null> {
  const c = await getConnector()
  try {
    const { wallet, accounts } = await c.getConnectedWallet()
    return accounts[0] ? { wallet, accountId: accounts[0].accountId } : null
  } catch {
    return null
  }
}

export async function connectWallet() {
  const c = await getConnector()
  const wallet = await c.connect()
  const accounts = await wallet.getAccounts({ network: config.network })
  if (!accounts[0]) throw new Error('The wallet returned no account.')
  return { wallet, accountId: accounts[0].accountId }
}

export async function disconnectWallet() {
  const c = await getConnector()
  try {
    await c.disconnect()
  } catch {}
}

const b64ToBytes = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

/** NEP-413 message signature for POST /auth/verify. The API requires a full-access key. */
export async function signLogin(
  wallet: NearWalletBase,
  accountId: string,
  challenge: { message: string; recipient: string; nonce: string },
) {
  const nonce = b64ToBytes(challenge.nonce)
  if (nonce.length !== 32) throw new Error('The API sent a malformed nonce.')
  // Sign only a login for this site: a relayed challenge for another app would carry another recipient or message
  const host = typeof location === 'undefined' ? '' : location.hostname
  if (
    challenge.recipient !== (config.authRecipient ?? host) ||
    challenge.message !== config.authMessage
  )
    throw new Error(
      `The API asked to sign a message for "${challenge.recipient}", not this site. Nothing was signed.`,
    )
  const signed = await wallet.signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce,
    network: config.network,
    signerId: accountId,
  })
  return {
    accountId: signed.accountId,
    publicKey: signed.publicKey,
    signature: signed.signature,
    nonce: challenge.nonce,
  }
}

export interface ShopCall {
  method: string
  args: Record<string, unknown>
  tgas: number
  deposit: string // yoctoNEAR
  /** Defaults to this deployment's vault */
  receiverId?: string
}

/** Signs and sends one function call on a vault from the connected wallet. */
export async function callShop(call: ShopCall) {
  const acct = await connectedAccount()
  if (!acct) throw new Error('Connect your wallet first.')
  return acct.wallet.signAndSendTransaction({
    network: config.network,
    signerId: acct.accountId,
    receiverId: call.receiverId ?? config.shopId,
    actions: [
      {
        type: 'FunctionCall',
        params: {
          methodName: call.method,
          args: call.args,
          gas: (BigInt(call.tgas) * 10n ** 12n).toString(),
          deposit: call.deposit,
        },
      },
    ],
  })
}

export const ONE_YOCTO = '1'

/** Signs a plan the API built, in order, from the account the plan names. */
export async function sendPlan(plan: {
  signerId: string
  transactions: Array<{ receiverId: string; actions: Array<ConnectorAction> }>
}) {
  const acct = await connectedAccount()
  if (!acct) throw new Error('Connect your wallet first.')
  if (acct.accountId !== plan.signerId)
    throw new Error(
      `The plan is for ${plan.signerId}, but the wallet is connected as ${acct.accountId}.`,
    )
  return acct.wallet.signAndSendTransactions({
    network: config.network,
    signerId: plan.signerId,
    transactions: plan.transactions,
  })
}

/** Signs actions the caller built and checked itself, as the account the caller expects. */
export async function signActions(
  expectedSigner: string,
  receiverId: string,
  actions: Array<ConnectorAction>,
) {
  const acct = await connectedAccount()
  if (!acct) throw new Error('Connect your wallet first.')
  if (acct.accountId !== expectedSigner)
    throw new Error(
      `Connect ${expectedSigner}; the wallet is connected as ${acct.accountId}.`,
    )
  return acct.wallet.signAndSendTransaction({
    network: config.network,
    signerId: expectedSigner,
    receiverId,
    actions,
  })
}
