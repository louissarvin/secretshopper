import { BACKGROUND_CONCURRENCY, BACKGROUND_RPC_PER_MINUTE, BACKGROUND_TXAPI_PER_MINUTE } from '../../config/main-config.ts';
import { createRateGate } from './rateGate.ts';

// One budget per provider for all background work in the API process; request handlers never wait on these.
export const backgroundRpc = createRateGate({ perMinute: BACKGROUND_RPC_PER_MINUTE, concurrency: BACKGROUND_CONCURRENCY });
export const backgroundTxApi = createRateGate({ perMinute: BACKGROUND_TXAPI_PER_MINUTE, concurrency: BACKGROUND_CONCURRENCY });
