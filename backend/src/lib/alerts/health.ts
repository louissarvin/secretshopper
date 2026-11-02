import { STALL_COMMIT, STALL_RELEASE, type HealthKind } from './map.ts';

// Pure: health conditions from chain and indexed facts, and which changes fire an alert.

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
// the indexer trails finality by INDEXER_FINALITY_LAG blocks (about 4 min); never call a release missing sooner
export const RELEASE_STALL_FLOOR_MS = 15 * MIN_MS;
// older delivery ticks are history, not a live stall (and predate 2.3.0 vaults' release method)
export const RELEASE_STALL_LOOKBACK_MS = 24 * HOUR_MS;
export const COMMIT_SLACK_MS = HOUR_MS;

/** How old a delivered tick must be, with no release posted for it, to count as a stall: two ticks, at least 15 min. */
export const releaseStallAgeMs = (tickMinutes: number): number => Math.max(2 * tickMinutes * MIN_MS, RELEASE_STALL_FLOOR_MS);

/** The newest delivered tick at least releaseStallAgeMs old has no indexed release_posted. */
export const releaseStalled = (p: { tickMs: number | null; posted: boolean; nowMs: number; tickMinutes: number }): boolean =>
  p.tickMs !== null && !p.posted && p.nowMs - p.tickMs >= releaseStallAgeMs(p.tickMinutes) && p.nowMs - p.tickMs <= RELEASE_STALL_LOOKBACK_MS;

/** Armed, and chain time is past the last batch (or the arming, if later) plus batch_interval plus 1 h. */
export const commitStalled = (p: { armed: boolean; lastBatchMs: number | null; armedAtMs: number; intervalMs: number; chainNowMs: number }): boolean =>
  p.armed && p.chainNowMs > Math.max(p.lastBatchMs ?? 0, p.armedAtMs) + p.intervalMs + COMMIT_SLACK_MS;

/** Largest gas key balance above key_allowance + 10%, in microNEAR (0 if none). DeleteKey fails above 1 NEAR (V23-01). */
export const overfundedMicroNear = (balancesYocto: bigint[], allowanceYocto: bigint): bigint => {
  const over = balancesYocto.filter((b) => b * 10n > allowanceYocto * 11n);
  return over.length ? over.reduce((a, b) => (b > a ? b : a)) / 1_000_000_000_000_000_000n : 0n;
};

export const stallBits = (release: boolean, commit: boolean): bigint => (release ? STALL_RELEASE : 0n) | (commit ? STALL_COMMIT : 0n);

/** Fire on state change only: a higher overdue count, a new stall reason, or a key newly overfunded. */
export const shouldFire = (kind: HealthKind, prev: bigint, next: bigint): boolean => {
  switch (kind) {
    case 'reveal_overdue':
      return next > prev;
    case 'tester_stalled':
      return (next & ~prev) !== 0n;
    case 'gas_key_overfunded':
      return prev === 0n && next > 0n;
  }
};
