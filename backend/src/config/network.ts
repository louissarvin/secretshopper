// Network-specific values derived from env. No required-var checks here: the API and the tester both import it.

export type NearNetwork = 'testnet' | 'mainnet';

export interface NearConfig {
  network: NearNetwork;
  rpcUrl: string; // single provider for lookups where "not found" is a valid answer
  rpcUrls: string[]; // failover list for everything else
  txApiUrl: string;
  neardataUrl: string;
  explorerUrl: string;
  fastnearApiKey: string;
}

// Public endpoints per network; each can be overridden by env.
const DEFAULTS: Record<NearNetwork, Omit<NearConfig, 'network' | 'fastnearApiKey'>> = {
  testnet: {
    rpcUrl: 'https://rpc.testnet.fastnear.com',
    // both FastNEAR hosts share one rate limit; dRPC (docs.near.org/api/rpc/providers) is an independent fallback
    rpcUrls: ['https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'],
    txApiUrl: 'https://tx.test.fastnear.com',
    neardataUrl: 'https://testnet.neardata.xyz',
    explorerUrl: 'https://testnet.nearblocks.io',
  },
  mainnet: {
    rpcUrl: 'https://rpc.mainnet.fastnear.com',
    rpcUrls: ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com'],
    txApiUrl: 'https://tx.main.fastnear.com',
    neardataUrl: 'https://mainnet.neardata.xyz',
    explorerUrl: 'https://nearblocks.io',
  },
};

// Plain http is only allowed for a local sandbox.
export const checkUrl = (name: string, value: string): string => {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error(`${name} must use https`);
  return value.replace(/\/+$/, '');
};

export const parseNetwork = (value: string | undefined): NearNetwork => {
  if (!value || value === 'testnet') return 'testnet';
  if (value === 'mainnet') return 'mainnet';
  throw new Error(`NEAR_NETWORK must be testnet or mainnet, got ${value}`);
};

export const nearConfigFromEnv = (env: Record<string, string | undefined> = process.env): NearConfig => {
  const network = parseNetwork(env.NEAR_NETWORK);
  const d = DEFAULTS[network];
  return {
    network,
    rpcUrl: checkUrl('NEAR_RPC_URL', env.NEAR_RPC_URL || d.rpcUrl),
    rpcUrls: (env.NEAR_RPC_URLS ? env.NEAR_RPC_URLS.split(',') : env.NEAR_RPC_URL ? [env.NEAR_RPC_URL] : d.rpcUrls)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => checkUrl('NEAR_RPC_URLS', s)),
    txApiUrl: checkUrl('NEAR_TX_API_URL', env.NEAR_TX_API_URL || d.txApiUrl),
    neardataUrl: checkUrl('NEARDATA_URL', env.NEARDATA_URL || d.neardataUrl),
    explorerUrl: checkUrl('EXPLORER_URL', env.EXPLORER_URL || d.explorerUrl),
    fastnearApiKey: env.FASTNEAR_API_KEY || '',
  };
};
