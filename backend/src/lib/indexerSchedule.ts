// Which vaults the indexer visits on a tick (backend/README.md, Multiple vaults; revised after the 2026-11-13 rate-limit incident).
// Pure: the worker keeps the per-vault state and passes the clock.

export const BACKOFF_MIN_MS = 30_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
export const IDLE_AFTER_MS = 24 * 3_600_000;
export const IDLE_EVERY_MS = 3_600_000;

export interface VaultSchedState {
  nextAt: number; // no visit before this (backoff)
  failures: number; // consecutive rate-limited visits
  lastVisitAt: number;
}

export interface SchedVault {
  shop: string;
  isDefault: boolean;
  testerEnabled: boolean;
  lastEventAtMs: number | null; // newest indexed event's block time
}

/** 30 s, 60 s, 120 s ... capped at 10 min, and never sooner than the server's Retry-After. */
export const backoffMs = (failures: number, retryAfter: number | null = null): number =>
  Math.max(Math.min(BACKOFF_MIN_MS * 2 ** Math.max(failures - 1, 0), BACKOFF_MAX_MS), Math.min(retryAfter ?? 0, BACKOFF_MAX_MS));

/** A non-default vault nobody tests that has had no event for a day: visited hourly. */
export const isIdle = (v: SchedVault, nowMs: number): boolean =>
  !v.isDefault && !v.testerEnabled && (v.lastEventAtMs === null || nowMs - v.lastEventAtMs > IDLE_AFTER_MS);

export const emptyState = (): VaultSchedState => ({ nextAt: 0, failures: 0, lastVisitAt: 0 });

/**
 * The default vault every tick unless it is backing off. Other vaults only every `otherEveryTicks`th tick, at most
 * `maxOthers` of them round robin from `rr`, skipping those backing off and idle ones visited within the hour.
 */
export const pickDue = (
  vaults: SchedVault[],
  states: Map<string, VaultSchedState>,
  tick: number,
  nowMs: number,
  o: { otherEveryTicks: number; maxOthers: number; rr: number }
): { due: SchedVault[]; rr: number } => {
  const st = (s: string) => states.get(s) ?? emptyState();
  const due = vaults.filter((v) => v.isDefault && st(v.shop).nextAt <= nowMs);
  const others = vaults.filter((v) => !v.isDefault);
  if (!others.length || o.maxOthers <= 0 || tick % o.otherEveryTicks !== 0) return { due, rr: o.rr };
  const eligible = (v: SchedVault) => st(v.shop).nextAt <= nowMs && (!isIdle(v, nowMs) || nowMs - st(v.shop).lastVisitAt >= IDLE_EVERY_MS);
  let rr = o.rr % others.length;
  let taken = 0;
  for (let i = 0; i < others.length && taken < o.maxOthers; i++) {
    const v = others[(rr + i) % others.length];
    if (eligible(v)) {
      due.push(v);
      taken++;
    }
  }
  rr = (rr + Math.max(taken, 1)) % others.length;
  return { due, rr };
};

/** State after a visit: success clears the backoff; a rate-limited visit doubles it. */
export const afterVisit = (prev: VaultSchedState, nowMs: number, r: { ok: true } | { ok: false; rateLimited: boolean; retryAfterMs: number | null }): VaultSchedState => {
  if (r.ok) return { nextAt: 0, failures: 0, lastVisitAt: nowMs };
  if (!r.rateLimited) return { ...prev, lastVisitAt: nowMs }; // other errors: next normal visit
  const failures = prev.failures + 1;
  return { nextAt: nowMs + backoffMs(failures, r.retryAfterMs), failures, lastVisitAt: nowMs };
};
