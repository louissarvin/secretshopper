import { env } from '@/env'

const NETWORK = env.VITE_NEAR_NETWORK

// Defaults match backend/src/config/network.ts
const DEFAULT_RPC = {
  testnet: [
    'https://rpc.testnet.fastnear.com',
    'https://test.rpc.fastnear.com',
  ],
  mainnet: [
    'https://rpc.mainnet.fastnear.com',
    'https://free.rpc.fastnear.com',
  ],
} as const

// NEAR account id, as in src/env.ts
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

const DEFAULT_EXPLORER = {
  testnet: 'https://testnet.nearblocks.io',
  mainnet: 'https://nearblocks.io',
} as const

export const config = {
  appName: 'Secret Shopper',
  appDescription:
    'Phishing drills for the AI agent that pays. The NEAR vault holding the money grades every decision and takes away the right to pay when the agent pays a fake.',
  apiUrl: env.VITE_API_URL.replace(/\/$/, ''),
  network: NETWORK,
  rpcUrls: env.VITE_NEAR_RPC_URLS
    ? env.VITE_NEAR_RPC_URLS.split(',')
        .map((u) => u.trim())
        .filter(Boolean)
    : [...DEFAULT_RPC[NETWORK]],
  shopId: env.VITE_SHOP_CONTRACT_ID,
  explorerUrl: (env.VITE_EXPLORER_URL ?? DEFAULT_EXPLORER[NETWORK]).replace(
    /\/$/,
    '',
  ),
  nearAiVerifyUrl: 'https://cloud.near.ai/verify',
  readonlyDemo: ['true', '1'].includes(env.VITE_READONLY_DEMO ?? ''),
  repoUrl: env.VITE_REPO_URL?.replace(/\/$/, ''),
  vaultCodeHash: env.VITE_VAULT_CODE_HASH,
  defaultTokenId: env.VITE_DEFAULT_TOKEN_ID,
  authRecipient: env.VITE_AUTH_RECIPIENT,
  authMessage: 'Sign in to Secret Shopper',
  // Gas from the repo's own scripts and tests; an Intents approve needs ft_transfer_call (100 Tgas) plus callbacks
  gasTgas: {
    approveNear: 100,
    approveIntents: 150,
    default: 30,
    keyChange: 50,
  },
  features: {
    smoothScroll: true,
  },
} as const

export const explorerTx = (hash: string) => `${config.explorerUrl}/txns/${hash}`
export const explorerAccount = (id: string) =>
  `${config.explorerUrl}/address/${id}`

export type Config = typeof config

/** Set when the API's vault or network differs from a pinned build; the app shows it as a banner. */
export const mismatch = { value: '' }

/**
 * Takes the vault, network and explorer from the API's GET /public/config (backend/API.md), the env being only the
 * fallback. Returns true when something changed, so the caller can re-render with the new values.
 */
export function applyPublicConfig(p: {
  network: string
  explorerUrl: string
  shop: string
}) {
  const explorer = p.explorerUrl.replace(/\/$/, '')
  const differs = p.shop !== config.shopId || p.network !== config.network
  // The network never switches at runtime, the vault id must be an account and the explorer a known one. A pinned
  // or production build never follows the API: the API must not be able to redirect what the owner signs.
  const pinned =
    import.meta.env.PROD ||
    !!import.meta.env.VITE_SHOP_CONTRACT_ID ||
    !!import.meta.env.VITE_NEAR_NETWORK
  if (
    pinned ||
    p.network !== config.network ||
    !ACCOUNT_ID.test(p.shop) ||
    !(Object.values(DEFAULT_EXPLORER) as Array<string>).includes(explorer)
  ) {
    if (differs)
      mismatch.value = `The API serves ${p.shop} on ${p.network}, but this site is built for ${config.shopId} on ${config.network}. Showing the build's vault.`
    return false
  }
  const changed = p.shop !== config.shopId || explorer !== config.explorerUrl
  // config is read synchronously everywhere, so it is updated in place before the re-render
  if (changed)
    Object.assign(config as Record<string, unknown>, {
      shopId: p.shop,
      explorerUrl: explorer,
    })
  return changed
}
