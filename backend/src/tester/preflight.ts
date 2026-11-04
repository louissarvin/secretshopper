import type { Mode } from '../lib/near/shop.ts';
import type { TesterKeyCheck, TesterState } from '../lib/proof/testerKey.ts';

// Pure: the tester's per-vault preflight (v2/37 section 6), cheapest checks first. Config-free so tests need no env.

export const LOW_FLOAT_YOCTO = 10n ** 23n; // 0.1 NEAR: below this a commit fails on chain (V2-09) and burns allowance

export interface PreflightFacts {
  ownerId: string; // get_status.owner_id now
  signerId: string; // owner recorded at enable, who holds the tester key
  key: TesterKeyCheck;
  commit?: {
    mode: Mode;
    vendors: number;
    batchSize: number;
    maxBatchSize: number;
    policyOk: boolean; // reveal grace and a release tick before the answer deadline
    headroomYocto: bigint;
    withinCapacity: boolean;
    luresLeftToday: number;
  };
}

/** The state to record. Without `commit` facts only the signing checks run (reveal, release, prove). */
export const decidePreflight = (f: PreflightFacts): TesterState => {
  if (f.ownerId !== f.signerId) return 'owner_changed';
  if (!f.key.ok) return f.key.code;
  const c = f.commit;
  if (!c) return 'ok';
  // ADR-7: no NEAR AI spend on an agent that cannot act
  if (c.mode !== 'Armed' && c.mode !== 'Demoted') return 'unarmed';
  if (c.vendors === 0) return 'no_vendors';
  if (c.batchSize > c.maxBatchSize || !c.policyOk) return 'policy_unsupported';
  if (c.headroomYocto < LOW_FLOAT_YOCTO) return 'low_float';
  if (!c.withinCapacity) return 'over_capacity';
  if (c.luresLeftToday <= 0) return 'budget';
  return 'ok';
};

// The tester can still sign reveals, releases and proofs in these states.
const SIGNABLE: ReadonlySet<TesterState> = new Set(['ok', 'unarmed', 'no_vendors', 'policy_unsupported', 'low_float', 'over_capacity', 'budget', 'error']);
export const canSign = (s: TesterState | null): boolean => s === null || SIGNABLE.has(s);

/** `budget` still commits, with void slots, so the cadence holds; every other non-ok state skips the commit. */
export const commitAllowed = (s: TesterState): boolean => s === 'ok' || s === 'budget';

/** Enabled non-default vaults served, oldest `testerEnabledAt` first (TESTER_MAX_VAULTS). */
export const withinCapacity = (enabled: { shop: string; enabledAt: Date | null }[], max: number): Set<string> =>
  new Set(
    [...enabled]
      .sort((a, b) => (a.enabledAt?.getTime() ?? Infinity) - (b.enabledAt?.getTime() ?? Infinity) || a.shop.localeCompare(b.shop))
      .slice(0, max)
      .map((e) => e.shop)
  );

/** Lure slots this batch may hold: the per-batch cap and what is left of the daily generation budget. */
export const lureAllowance = (isDefault: boolean, batchSize: number, maxPerBatch: number, attemptsToday: number, maxPerDay: number): number =>
  isDefault ? batchSize : Math.max(0, Math.min(maxPerBatch, batchSize, maxPerDay - attemptsToday));
