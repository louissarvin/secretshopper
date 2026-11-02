import { z } from 'zod';
import { view } from '../near/client.ts';
import { getStatus } from '../near/shop.ts';
import { cached } from '../../utils/ttlCache.ts';
import type { ActivityContext } from './map.ts';

const ftMetadata = z.object({ symbol: z.string().min(1).max(32).regex(/^[A-Za-z0-9.$-]+$/), decimals: z.number().int().min(0).max(38) });

/** Vault token symbol and decimals for alert texts; undefined when the chain read fails, so amounts fall back to base units. */
export const alertToken = async (vault: string): Promise<ActivityContext['token']> => {
  try {
    const status = await cached(`status:${vault}`, 60_000, () => getStatus(vault));
    return ftMetadata.parse(await cached(`ft_metadata:${status.token_id}`, 3_600_000, () => view<unknown>(status.token_id, 'ft_metadata')));
  } catch {
    return undefined;
  }
};
