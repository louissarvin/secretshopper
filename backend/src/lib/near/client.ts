import { FailoverRpcProvider, JsonRpcProvider } from 'near-api-js';
import { nearConfigFromEnv } from '../../config/network.ts';

export const NEAR = nearConfigFromEnv();

// Only send the FastNEAR key to FastNEAR hosts.
export const fastnearHeaders = (url: string): Record<string, string> | undefined =>
  NEAR.fastnearApiKey && new URL(url).hostname.endsWith('fastnear.com')
    ? { Authorization: `Bearer ${NEAR.fastnearApiKey}` }
    : undefined;

const makeRpc = (url: string): JsonRpcProvider =>
  new JsonRpcProvider({ url, headers: fastnearHeaders(url) }, { retries: 3, backoff: 2, wait: 500 });

// Single provider: "key/account not found" must surface as an error, not trigger failover.
export const rpc: JsonRpcProvider = makeRpc(NEAR.rpcUrl);
export const failoverRpc: FailoverRpcProvider = new FailoverRpcProvider(NEAR.rpcUrls.map(makeRpc));

export const getFinalBlockHeight = async (): Promise<number> => {
  const block = await failoverRpc.viewBlock({ finality: 'final' });
  return block.header.height;
};

/** Time of the newest (optimistic) block: the closest estimate of the block that will include a tx sent now. */
export const chainHeadMs = async (): Promise<number> => {
  const block = await failoverRpc.viewBlock({ finality: 'optimistic' });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
};

/** Chain time of the latest final block (SS-B08: judge expiry by chain time, not the local clock). */
export const chainNowMs = async (): Promise<number> => {
  const block = await failoverRpc.viewBlock({ finality: 'final' });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
};

export const view = async <T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> =>
  (await failoverRpc.callFunction({ contractId, method, args })) as T;

export const explorerTxUrl = (txHash: string): string => `${NEAR.explorerUrl}/txns/${txHash}`;
