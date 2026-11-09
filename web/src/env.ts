import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

export const env = createEnv({
  server: {
    SERVER_URL: z.string().url().optional(),
  },

  clientPrefix: 'VITE_',

  client: {
    VITE_API_URL: z.string().url().default('http://127.0.0.1:3700'),
    VITE_NEAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
    // Comma list, tried in order on failure
    VITE_NEAR_RPC_URLS: z.string().min(1).optional(),
    VITE_SHOP_CONTRACT_ID: z
      .string()
      .regex(ACCOUNT_RE)
      .default('shop4.ss-owner-e9c3db.testnet'),
    VITE_EXPLORER_URL: z.string().url().optional(),
    // Hosted demo: the API serves public routes only, so sign-in and owner or vendor actions run locally
    VITE_READONLY_DEMO: z.enum(['true', 'false', '1', '0']).optional(),
    // Public repository, for links to the evidence files
    VITE_REPO_URL: z.string().url().startsWith('https://').optional(),
    // The audited vault code a new vault must run; the API's plan is checked against it, never trusted for it
    // Token a new vault pays in when the owner leaves the field empty; pinned so the API cannot pick it
    VITE_DEFAULT_TOKEN_ID: z
      .string()
      .regex(ACCOUNT_RE)
      .default('tusdc.ss-owner-e9c3db.testnet'),
    // The NEP-413 recipient the API signs logins for; defaults to this page's hostname (API AUTH_RECIPIENT)
    VITE_AUTH_RECIPIENT: z.string().min(1).max(253).optional(),
    VITE_VAULT_CODE_HASH: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
      .default('5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs'),
  },

  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
})
