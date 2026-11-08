import { JsonRpcProvider } from 'near-api-js';
import { nearConfigFromEnv } from '../../backend/src/config/network.ts';

// Same network defaults as the backend (testnet unless NEAR_NETWORK=mainnet).
export const NEAR = nearConfigFromEnv();
export const provider = new JsonRpcProvider({ url: NEAR.rpcUrl }, { retries: 3, backoff: 2, wait: 500 });
export const txUrl = (hash: string): string => `${NEAR.explorerUrl}/txns/${hash}`;

export const req = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    process.stderr.write(`Missing env ${k}\n`);
    process.exit(1);
  }
  return v;
};

export const view = async <T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> =>
  (await provider.callFunction({ contractId, method, args })) as T;

export const errorText = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const extra = JSON.stringify(e, Object.getOwnPropertyNames(e).filter((k) => k !== 'stack'));
  return `${e.constructor.name}: ${e.message} ${extra}`;
};
