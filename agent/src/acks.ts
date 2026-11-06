import type { InboxItem } from './inbox.ts';
import type { Release } from './vault.ts';
import { merkleRootHex } from './merkle.ts';

// v2/32: the agent signs one Merkle root per inbox release tick. A tick holds only ids the decision loop decided or
// found decided, so a backend that answers two walks differently cannot add an id (AG-01, AG-03).
// Acks have their own rolling cap (48 per 24 h, V23-06) and never spend max_decisions_per_day; a refused ack backs off.

export interface PendingAck {
  receivedAt: string; // ISO tick time, as the inbox reports it
  root: string;
  count: number;
  attempts: number;
  retryAt?: number; // ms; backoff after a failed ack
}

export interface AckState {
  open: { receivedAt: string; ids: string[] } | null; // the tick being collected
  last: string | null; // newest closed tick; never reopened
  pending: PendingAck[]; // closed ticks not acked yet, oldest first
  acked: string[]; // release_at (ns) of recent acks, newest last
}

export const emptyAckState = (): AckState => ({ open: null, last: null, pending: [], acked: [] });

/** Same time base as the tester's release_at: the tick in ns since epoch. */
export const releaseAtNs = (receivedAt: string): string => (BigInt(Date.parse(receivedAt)) * 1_000_000n).toString();

// A tick is closed once the inbox shows a later one, or this long after the tick with nothing new; the tester
// waits the same RELEASE_SETTLE_MS before taking its root, so both see the same set.
export const TICK_SETTLE_MS = 60_000;
const MAX_RELEASE_WAIT_MS = 7 * 86_400_000; // a tester that never posts: stop waiting
const MAX_ACKED_KEPT = 200;
const MAX_BACKOFF_MS = 3_600_000;

export interface AckDeps {
  getRelease: (releaseAtNs: string) => Promise<Release | null>;
  ack: (releaseAtNs: string, root: string) => Promise<{ txHash: string }>;
  canSign: () => Promise<boolean>; // Armed or Demoted with this agent's key
  save: () => Promise<void>;
  nowMs: () => number;
  log: { info: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void; error: (m: string, f?: Record<string, unknown>) => void };
}

const close = (st: AckState): void => {
  if (!st.open) return;
  st.pending.push({ receivedAt: st.open.receivedAt, root: merkleRootHex(st.open.ids), count: st.open.ids.length, attempts: 0 });
  st.last = st.open.receivedAt;
  st.open = null;
};

/** Folds an item the decision loop is done with. False if its tick is already closed: it is never reopened. */
export const noteDone = (st: AckState, item: Pick<InboxItem, 'id' | 'receivedAt'>): boolean => {
  const at = Date.parse(item.receivedAt);
  if (st.open && at > Date.parse(st.open.receivedAt)) close(st);
  if (st.open ? at < Date.parse(st.open.receivedAt) : st.last !== null && at <= Date.parse(st.last)) return false;
  st.open ??= { receivedAt: item.receivedAt, ids: [] };
  if (!st.open.ids.includes(item.id)) st.open.ids.push(item.id);
  return true;
};

/** Closes the open tick once the decision loop's next item is from a later tick, or the inbox stayed empty past the settle time. */
export const closeTicks = (st: AckState, nextAt: string | null, nowMs: number): boolean => {
  if (!st.open) return false;
  const openAt = Date.parse(st.open.receivedAt);
  const settled = nextAt === null ? nowMs >= openAt + TICK_SETTLE_MS : Date.parse(nextAt) > openAt;
  if (settled) close(st);
  return settled;
};

/** Acks every pending tick whose release is on chain. The contract allows one ack per tick, so a restart cannot double-sign. */
export const ackPending = async (st: AckState, d: AckDeps): Promise<void> => {
  if (st.pending.length === 0 || !(await d.canSign())) return;
  for (const t of [...st.pending]) {
    const now = d.nowMs();
    if (now - Date.parse(t.receivedAt) > MAX_RELEASE_WAIT_MS) {
      // no release ever posted, or a vault without ack (before 2.3.0): stop carrying the tick
      d.log.warn('giving up on the ack for this tick', { receivedAt: t.receivedAt, count: t.count, attempts: t.attempts });
      st.pending = st.pending.filter((p) => p !== t);
      await d.save();
      continue;
    }
    if (t.retryAt && now < t.retryAt) continue;
    const at = releaseAtNs(t.receivedAt);
    const done = async (): Promise<void> => {
      st.pending = st.pending.filter((p) => p !== t);
      st.acked = [...st.acked, at].slice(-MAX_ACKED_KEPT);
      await d.save();
    };
    try {
      const rel = await d.getRelease(at);
      if (!rel) continue; // the tester posts once the tick settles
      if (rel.ack) {
        d.log.info('tick already acked on chain', { receivedAt: t.receivedAt, matches: rel.ack.root === t.root });
        await done();
        continue;
      }
      // a different root is still signed: it is the on-chain record that this inbox differs from the release
      if (rel.root !== t.root) d.log.warn('my root differs from the release root', { receivedAt: t.receivedAt, mine: t.root, mineCount: t.count, released: rel.root, releasedCount: rel.count });
      const { txHash } = await d.ack(at, t.root);
      d.log.info('tick acked', { receivedAt: t.receivedAt, count: t.count, root: t.root, matches: rel.root === t.root, txHash });
      await done();
    } catch (error) {
      t.attempts++;
      t.retryAt = now + Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** t.attempts);
      d.log.error('ack failed', { receivedAt: t.receivedAt, attempts: t.attempts, error: error instanceof Error ? error.message : String(error) });
      await d.save();
    }
  }
};

/** Acks what is pending. Errors are logged; invoice processing never waits on acks. */
export const syncAcks = async (st: AckState, d: AckDeps): Promise<void> => {
  try {
    await ackPending(st, d);
  } catch (error) {
    d.log.error('ack sync failed', { error: error instanceof Error ? error.message : String(error) });
  }
};
