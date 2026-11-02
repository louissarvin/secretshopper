import { roundUpToSlot } from '../utils/delivery.ts';
import { drandRoundTimeMs } from './proof/tlock.ts';

// Public batch-level timing of a vault: when the inbox releases next, when the next test batch may be committed and
// when the oldest open batch can be revealed. Everything here is on chain already; nothing says which inbox item is a
// test. Pure: chain reads come in through `ScheduleReads`.

export interface ScheduleBatch {
  first_slot: number;
  count: number;
  committed_at: string; // ns
  expires_at: string; // ns
  unrevealed: number;
}

export interface ScheduleSlot {
  expires_at: string;
  tlock_round: number;
  status: string;
}

export interface ScheduleReads {
  batches(from: number, limit: number): Promise<ScheduleBatch[]>;
  tests(from: number, limit: number): Promise<ScheduleSlot[]>;
  batchIntervalNs(): Promise<string>;
}

export interface ChainSchedule {
  lastBatch: { batchIndex: number; committedAt: string; expiresAt: string } | null;
  nextBatchEarliestAt: string | null;
  pending: number;
  nextRevealAfter: string | null;
}

export interface Schedule extends ChainSchedule {
  now: string;
  releaseTickMinutes: number;
  nextReleaseAt: string;
}

const PAGE = 100; // the contract's page cap
const MAX_PAGES = 200; // 20,000 batches; past this the vault is far beyond its intended cadence
const iso = (ns: string | bigint) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

/** Chain part, cacheable: walks get_batches, then reads the slots of the open batch that expires first. */
export const readChainSchedule = async (r: ScheduleReads): Promise<ChainSchedule> => {
  const all: ScheduleBatch[] = [];
  for (let i = 0; ; i++) {
    if (i === MAX_PAGES) throw new Error('schedule: too many batches to page');
    const page = await r.batches(all.length, PAGE);
    all.push(...page);
    if (page.length < PAGE) break;
  }
  const last = all.at(-1);
  const lastBatch = last ? { batchIndex: all.length - 1, committedAt: iso(last.committed_at), expiresAt: iso(last.expires_at) } : null;
  const nextBatchEarliestAt = last ? iso(BigInt(last.committed_at) + BigInt(await r.batchIntervalNs())) : null;
  const open = all.filter((b) => b.unrevealed > 0);
  const pending = open.reduce((n, b) => n + b.unrevealed, 0);
  let nextRevealAfter: string | null = null;
  if (open.length) {
    const first = open.reduce((a, b) => (BigInt(b.expires_at) < BigInt(a.expires_at) ? b : a));
    // a slot opens once it has expired and its drand round is out; the earliest such slot in that batch decides
    const slots = (await r.tests(first.first_slot, first.count)).filter((s) => s.status === 'Committed');
    const opensAt = (s: ScheduleSlot) => {
      const exp = Number(BigInt(s.expires_at) / 1_000_000n);
      return Math.max(exp, s.tlock_round > 0 ? drandRoundTimeMs(s.tlock_round) : 0);
    };
    const t = slots.length ? Math.min(...slots.map(opensAt)) : Number(BigInt(first.expires_at) / 1_000_000n);
    nextRevealAfter = new Date(t).toISOString();
  }
  return { lastBatch, nextBatchEarliestAt, pending, nextRevealAfter };
};

/** Adds the request-time fields: `nextReleaseAt` is the next inbox tick on the UTC grid the tester uses. */
export const withClock = (c: ChainSchedule, nowMs: number, tickMinutes: number): Schedule => ({
  now: new Date(nowMs).toISOString(),
  releaseTickMinutes: tickMinutes,
  nextReleaseAt: new Date(roundUpToSlot(nowMs, tickMinutes)).toISOString(),
  ...c,
});
