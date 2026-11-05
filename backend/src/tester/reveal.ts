import type { ChainTestSlot, PayeeSeen } from '../lib/near/shop.ts';
import { nsToDate } from '../lib/near/shop.ts';
import type { Sealed } from './slots.ts';

/**
 * Reveal now if the test payee was touched by the vault (Failed, or Invalid if before the commit),
 * otherwise only once chain time has passed expiry (Passed, Unanswered or Void).
 * `chainNowMs` is the final block time: a reveal sent early would fail but publish the preimage (SS-B08).
 */
export const shouldReveal = (s: Pick<Sealed, 'payee'>, chain: ChainTestSlot, touched: PayeeSeen | null, chainNowMs: number): boolean => {
  if (chain.status !== 'Committed') return false;
  if (s.payee && touched) return true;
  return chainNowMs >= nsToDate(chain.expires_at).getTime();
};
