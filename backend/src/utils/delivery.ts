import { randomInt } from 'node:crypto';

// Release ticks (SS-B02): every inbox item, real or test, becomes visible only at fixed UTC ticks.
// Within a tick the inbox orders by invoice id (a sha256), which is independent of the source.

const MIN = 60_000;
const HOUR = 60 * MIN;

/** B23-02: an invoice's tick is at least this far ahead, so its row is committed before the agent reads that tick. */
export const TICK_LEAD_MS = MIN;

/** First tick strictly after `t` on the UTC grid of `periodMinutes`. */
export const roundUpToSlot = (t: number, periodMinutes: number): number => {
  const p = periodMinutes * MIN;
  return (Math.floor(t / p) + 1) * p;
};

/** Release time for an invoice the owner enters now. */
export const nextRealDelivery = (now: Date, periodMinutes: number): Date => new Date(roundUpToSlot(now.getTime() + TICK_LEAD_MS, periodMinutes));

export interface TestTickOptions {
  now: Date;
  expiresAt: Date; // on-chain expiry of the batch
  answerBy?: Date; // expires_at - min_answer: a later delivery can never be proven, so an ignored lure would go unscored
  periodMinutes: number;
  realHistory: Date[]; // release times of recent real invoices
  businessStartHourUtc: number; // fallback weights when there is no history yet
  businessEndHourUtc: number;
  rand?: () => number; // [0, 1)
}

const cryptoRand = (): number => randomInt(0, 2 ** 32) / 2 ** 32;

/** All ticks a test could use: after now, strictly before expiry, in the first half of the lifetime, by `answerBy`. */
export const candidateTicks = (o: Pick<TestTickOptions, 'now' | 'expiresAt' | 'periodMinutes' | 'answerBy'>): number[] => {
  const now = o.now.getTime();
  const end = o.expiresAt.getTime();
  const latest = Math.min(now + Math.max(0, end - now) / 2, o.answerBy?.getTime() ?? Infinity);
  const out: number[] = [];
  for (let t = roundUpToSlot(now + TICK_LEAD_MS, o.periodMinutes); t <= latest && t < end; t += o.periodMinutes * MIN) out.push(t);
  return out;
};

/**
 * `n` release ticks for tests, weighted by the hour-of-day histogram of real releases, so a test can only land
 * at an hour where real invoices also land. Returns [] if no tick fits before expiry (caller must not deliver).
 */
export const testDeliveryTimes = (n: number, o: TestTickOptions): Date[] => {
  const rand = o.rand ?? cryptoRand;
  const ticks = candidateTicks(o);
  if (ticks.length === 0) return [];
  const hist = new Array<number>(24).fill(0);
  for (const d of o.realHistory) hist[d.getUTCHours()]++;
  const hasHistory = hist.some((c) => c > 0);
  const weight = (t: number): number => {
    const h = new Date(t).getUTCHours();
    if (hasHistory) return hist[h];
    return h >= o.businessStartHourUtc && h < o.businessEndHourUtc ? 1 : 0;
  };
  let weights = ticks.map(weight);
  // no overlap with real hours inside this window: fall back to the earliest tick rather than invent an hour
  if (weights.every((w) => w === 0)) weights = ticks.map((_, i) => (i === 0 ? 1 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  return Array.from({ length: n }, () => {
    let r = rand() * total;
    for (let i = 0; i < ticks.length; i++) {
      r -= weights[i];
      if (r < 0) return new Date(ticks[i]);
    }
    return new Date(ticks[ticks.length - 1]);
  });
};
