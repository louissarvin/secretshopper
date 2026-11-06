// Env readers shared by the native agent and the MCP server configs.

export const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};

export const httpsUrl = (k: string, v: string): string => {
  const u = new URL(v);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error(`${k} must use https`);
  return v.replace(/\/+$/, '');
};

// a typo must stop the agent at start, not turn into NaN gas or a broken amount regex (AG-06)
export const int = (k: string, def: number, min: number, max: number): number => {
  const raw = process.env[k];
  const v = raw === undefined || raw === '' ? def : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${k} must be an integer from ${min} to ${max}`);
  return v;
};

// decimal settings such as prices, with the same fail-at-start rule as int (AG-06)
export const num = (k: string, def: number, min: number, max: number): number => {
  const raw = process.env[k];
  const v = raw === undefined || raw === '' ? def : /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k} must be a number from ${min} to ${max}`);
  return v;
};

export const nearNetwork = () => {
  const network = process.env.NEAR_NETWORK || 'testnet';
  if (network !== 'testnet' && network !== 'mainnet') throw new Error('NEAR_NETWORK must be testnet or mainnet');
  const defaults = {
    testnet: { rpc: 'https://rpc.testnet.fastnear.com', txApi: 'https://tx.test.fastnear.com' },
    mainnet: { rpc: 'https://rpc.mainnet.fastnear.com', txApi: 'https://tx.main.fastnear.com' },
  }[network];
  return { network, defaults } as const;
};

/** Chain, vault and inbox settings both entry points share; no NEAR AI key here. */
export const chainConfig = () => {
  const { network, defaults } = nearNetwork();
  return {
    NEAR_NETWORK: network,
    AGENT_VAULT_ID: req('AGENT_VAULT_ID'),
    AGENT_PRIVATE_KEY: req('AGENT_PRIVATE_KEY'), // ed25519:..., FC key on the vault (pay,decline,ack or propose,decline,ack)
    AGENT_COMPANY_NAME: process.env.AGENT_COMPANY_NAME || 'the company',
    NEAR_RPC_URL: httpsUrl('NEAR_RPC_URL', process.env.NEAR_RPC_URL || defaults.rpc),
    NEAR_TX_API_URL: httpsUrl('NEAR_TX_API_URL', process.env.NEAR_TX_API_URL || defaults.txApi),
    FASTNEAR_API_KEY: process.env.FASTNEAR_API_KEY || '',
    // Intents has no testnet: the rail is offered only if this is set and matches the vault's intents_id.
    INTENTS_CONTRACT_ID: process.env.INTENTS_CONTRACT_ID || '',
    TOKEN_DECIMALS: int('TOKEN_DECIMALS', 6, 1, 24),
    // V2 pay(.., listed_only): the contract itself refuses payees not approved on the vault. Default on.
    AGENT_LISTED_ONLY: (process.env.AGENT_LISTED_ONLY ?? 'true').toLowerCase() !== 'false',
    INBOX_URL: httpsUrl('INBOX_URL', req('INBOX_URL')),
    INBOX_TOKEN: req('INBOX_TOKEN'),
    POLL_MS: int('AGENT_POLL_MS', 15_000, 1_000, 3_600_000),
    PAY_TGAS: int('AGENT_PAY_TGAS', 80, 30, 300),
    PAY_INTENTS_TGAS: int('AGENT_PAY_INTENTS_TGAS', 150, 120, 300),
    CALL_TGAS: int('AGENT_CALL_TGAS', 30, 5, 300),
  };
};
