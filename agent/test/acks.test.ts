import { describe, expect, test } from 'bun:test';
import { closeTicks, emptyAckState, noteDone, releaseAtNs, syncAcks, TICK_SETTLE_MS, type AckDeps, type AckState } from '../src/acks.ts';
import { merkleRootHex } from '../src/merkle.ts';
import type { Cursor, InboxItem } from '../src/inbox.ts';
import type { Release } from '../src/vault.ts';

const T0 = Date.parse('2026-11-10T08:00:00.000Z');
const TICK = 120 * 60_000;
const id = (n: number) => n.toString(16).padStart(64, '0');

// Inbox with the /inbox/next rules: visible once deliverAt <= now, ordered by (deliverAt, id), cursor exclusive.
const inbox = (rows: { id: string; at: number }[], now: () => number) => async (c: Cursor | null): Promise<InboxItem | null> => {
  const sorted = rows
    .filter((r) => r.at <= now())
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    .filter((r) => !c || r.at > Date.parse(c.afterAt) || (r.at === Date.parse(c.afterAt) && r.id > c.afterId));
  const r = sorted[0];
  return r ? { id: r.id, receivedAt: new Date(r.at).toISOString(), email: {}, document: {} } : null;
};

// Vault stand-in with the contract's rules: ack needs a release and happens once.
const chain = () => {
  const releases = new Map<string, Release>();
  const acks: { at: string; root: string }[] = [];
  return {
    releases,
    acks,
    post: (atMs: number, ids: string[]) => releases.set(releaseAtNs(new Date(atMs).toISOString()), { root: merkleRootHex(ids), count: ids.length, at: '0', ack: null }),
    getRelease: async (at: string) => releases.get(at) ?? null,
    ack: async (at: string, root: string) => {
      const r = releases.get(at);
      if (!r) throw new Error('no release at release_at');
      if (r.ack) throw new Error('release already acked');
      r.ack = { root, at: '0', key: 'ed25519:agent' };
      acks.push({ at, root });
      return { txHash: `tx${acks.length}` };
    },
  };
};

// The decision loop as index.ts runs it: fetch at its cursor, close ticks on what it sees, fold an item only once done.
type Next = (c: Cursor | null) => Promise<InboxItem | null>;
const decide = async (st: AckState, cur: { c: Cursor | null }, next: Next, nowMs: number, done: (i: InboxItem) => boolean = () => true) => {
  for (let i = 0; i < 100; i++) {
    const item = await next(cur.c);
    closeTicks(st, item?.receivedAt ?? null, nowMs);
    if (!item || !done(item)) return;
    noteDone(st, item);
    cur.c = { afterAt: item.receivedAt, afterId: item.id };
  }
};

const setup = (rows: { id: string; at: number }[], startMs: number) => {
  let now = startMs;
  const c = chain();
  const logs: string[] = [];
  const st: AckState = emptyAckState();
  const cur = { c: null as Cursor | null };
  const next = inbox(rows, () => now);
  const deps: AckDeps = {
    getRelease: c.getRelease,
    ack: c.ack,
    canSign: async () => true,
    save: async () => {},
    nowMs: () => now,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  };
  const sync = async (state: AckState = st) => {
    await decide(state, cur, next, now);
    await syncAcks(state, deps);
  };
  return { st, deps, c, logs, cur, next, sync, now: () => now, setNow: (t: number) => (now = t) };
};

describe('agent release acks', () => {
  test('one ack per tick over every id of that tick, after the release is posted', async () => {
    const tick1 = [id(3), id(1), id(2)];
    const tick2 = [id(9)];
    const rows = [...tick1.map((x) => ({ id: x, at: T0 })), ...tick2.map((x) => ({ id: x, at: T0 + TICK }))];
    const s = setup(rows, T0 + TICK + TICK_SETTLE_MS);

    await s.sync(); // no release yet: nothing signed, ticks kept
    expect(s.c.acks).toHaveLength(0);
    expect(s.st.pending.map((p) => p.count)).toEqual([3, 1]);

    s.c.post(T0, tick1);
    s.c.post(T0 + TICK, tick2);
    await s.sync();
    expect(s.c.acks).toEqual([
      { at: (BigInt(T0) * 1_000_000n).toString(), root: merkleRootHex(tick1) },
      { at: (BigInt(T0 + TICK) * 1_000_000n).toString(), root: merkleRootHex(tick2) },
    ]);
    expect(s.st.pending).toHaveLength(0);
    expect(s.st.acked).toHaveLength(2);

    await s.sync(); // nothing new, nothing re-signed
    expect(s.c.acks).toHaveLength(2);
  });

  test('a tick is not closed while it could still grow', async () => {
    const s = setup([{ id: id(1), at: T0 }], T0 + 1_000);
    await decide(s.st, s.cur, s.next, s.now());
    expect(s.st.open?.ids).toEqual([id(1)]);
    expect(s.st.pending).toHaveLength(0);
    s.setNow(T0 + TICK_SETTLE_MS);
    await decide(s.st, s.cur, s.next, s.now());
    expect(s.st.open).toBeNull();
    expect(s.st.pending[0]).toMatchObject({ count: 1, root: merkleRootHex([id(1)]) });
  });

  test('the first item of the next tick closes the earlier one; a restart resumes from the saved state', async () => {
    const rows = [
      { id: id(1), at: T0 },
      { id: id(2), at: T0 },
      { id: id(5), at: T0 + TICK },
    ];
    const s = setup(rows, T0 + TICK + 1_000);
    s.c.post(T0, [id(1), id(2)]);
    await s.sync();
    expect(s.c.acks).toHaveLength(1);
    expect(s.st.open?.receivedAt).toBe(new Date(T0 + TICK).toISOString());

    // restart: a fresh process loads the same state; the acked tick is not signed again
    const st2: AckState = JSON.parse(JSON.stringify(s.st));
    s.setNow(T0 + TICK + TICK_SETTLE_MS);
    s.c.post(T0 + TICK, [id(5)]);
    await s.sync(st2);
    expect(s.c.acks.map((a) => a.root)).toEqual([merkleRootHex([id(1), id(2)]), merkleRootHex([id(5)])]);
  });

  test('an ack already on chain is not resent; a differing root is still signed', async () => {
    const s = setup([{ id: id(1), at: T0 }, { id: id(2), at: T0 + TICK }], T0 + TICK + TICK_SETTLE_MS);
    s.c.post(T0, [id(1)]);
    await s.c.ack(releaseAtNs(new Date(T0).toISOString()), merkleRootHex([id(1)])); // signed before a crash
    s.c.post(T0 + TICK, [id(2), id(7)]); // the tester released an id this inbox never showed
    await s.sync();
    expect(s.c.acks).toHaveLength(2);
    expect(s.c.acks[1].root).toBe(merkleRootHex([id(2)]));
    expect(s.logs).toContain('tick already acked on chain');
    expect(s.logs).toContain('my root differs from the release root');
    expect(s.st.pending).toHaveLength(0);
  });

  test('no signing while the key is not armed; a failed ack backs off and retries', async () => {
    const s = setup([{ id: id(1), at: T0 }], T0 + TICK_SETTLE_MS);
    s.c.post(T0, [id(1)]);
    let armed = false;
    s.deps.canSign = async () => armed;
    await s.sync();
    expect(s.c.acks).toHaveLength(0);

    armed = true;
    const realAck = s.deps.ack;
    s.deps.ack = async () => {
      throw new Error('Exceeded the prepaid gas');
    };
    await s.sync();
    expect(s.st.pending[0].attempts).toBe(1);
    s.deps.ack = realAck;
    await s.sync(); // still inside the backoff
    expect(s.c.acks).toHaveLength(0);
    s.setNow(s.st.pending[0].retryAt!);
    await s.sync();
    expect(s.c.acks).toHaveLength(1);
  });

  test('a tick whose release never comes is dropped after a week', async () => {
    const s = setup([{ id: id(1), at: T0 }], T0 + TICK_SETTLE_MS);
    await s.sync();
    expect(s.st.pending).toHaveLength(1);
    s.setNow(T0 + 8 * 86_400_000);
    await s.sync();
    expect(s.st.pending).toHaveLength(0);
    expect(s.c.acks).toHaveLength(0);
  });

  test('AG-01: a forked inbox cannot put an id the decision loop never finished into an ack', async () => {
    const REAL = id(1);
    const LURE = id(2);
    const at = new Date(T0).toISOString();
    // the backend shows LURE once, then answers the same cursor with REAL only
    let shown = false;
    const forked: Next = async (c) => {
      if (c) return null;
      if (!shown) return ((shown = true), { id: LURE, receivedAt: at, email: {}, document: {} });
      return { id: REAL, receivedAt: at, email: {}, document: {} };
    };
    const s = setup([], T0 + TICK_SETTLE_MS);
    s.c.post(T0, [REAL, LURE]);
    // the model call on LURE fails, so the loop keeps its cursor and fetches again
    await decide(s.st, s.cur, forked, s.now(), (i) => i.id !== LURE);
    await decide(s.st, s.cur, forked, s.now());
    await syncAcks(s.st, s.deps);
    expect(s.c.acks).toEqual([{ at: releaseAtNs(at), root: merkleRootHex([REAL]) }]);
    expect(s.c.acks[0].root).not.toBe(merkleRootHex([REAL, LURE])); // a mismatch: LURE can never be proven Ignored
  });

  test('AG-01: a closed tick is never reopened by a late or out-of-order item', () => {
    const st = emptyAckState();
    expect(noteDone(st, { id: id(1), receivedAt: new Date(T0).toISOString() })).toBe(true);
    expect(noteDone(st, { id: id(2), receivedAt: new Date(T0 + TICK).toISOString() })).toBe(true);
    expect(st.pending.map((p) => p.root)).toEqual([merkleRootHex([id(1)])]);
    expect(noteDone(st, { id: id(3), receivedAt: new Date(T0).toISOString() })).toBe(false);
    expect(closeTicks(st, new Date(T0).toISOString(), T0 + 10 * TICK)).toBe(false); // an older next item does not close the open tick
    expect(closeTicks(st, null, T0 + TICK + TICK_SETTLE_MS)).toBe(true);
    expect(st.pending.map((p) => p.count)).toEqual([1, 1]);
    expect(noteDone(st, { id: id(4), receivedAt: new Date(T0 + TICK).toISOString() })).toBe(false);
  });
});
