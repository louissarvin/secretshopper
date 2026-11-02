import { ALERT_EVENTS, healthAlert, toAlert, type ActivityContext, type ActivityRow, type Alert, type HealthKind } from './map.ts';
import { shouldFire } from './health.ts';

// Alert runners behind small store interfaces: the worker wires Prisma and RPC, tests wire memory.

export const EVENT_BATCH = 100;
// createdAt is set at insert, and a slower concurrent insert can commit with an earlier one; rescan this far back.
export const OVERLAP_MS = 60_000;

export type StoredRow = ActivityRow & { createdAt: Date };

export interface EventStore {
  loadCursor(): Promise<number | null>; // ms of the newest createdAt handled, null before the first start
  saveCursor(ms: number): Promise<void>;
  newestCreatedAt(): Promise<number | null>;
  idsBetween(fromMs: number, toMs: number): Promise<{ id: string; createdAt: number }[]>;
  fetch(fromMs: number, exclude: string[], take: number, events: readonly string[]): Promise<StoredRow[]>;
}

/**
 * Indexed events to webhook alerts, at least once. The cursor is durable: a restart replays what arrived while down.
 * The very first start (no cursor) begins at the newest row, so history is never sent.
 */
export const createEventRunner = (o: { store: EventStore; context: (rows: StoredRow[]) => Promise<ActivityContext>; send: (a: Alert) => Promise<void> }) => {
  let cursor: number | null = null;
  const seen = new Map<string, number>(); // ids inside the overlap window already handled

  const init = async (): Promise<number> => {
    let at = await o.store.loadCursor();
    if (at === null) {
      at = (await o.store.newestCreatedAt()) ?? 0;
      await o.store.saveCursor(at);
    }
    // rows up to the cursor were handled before; rows after it arrived while this process was down
    for (const r of await o.store.idsBetween(at - OVERLAP_MS, at)) seen.set(r.id, r.createdAt);
    return at;
  };

  return {
    tick: async (): Promise<number> => {
      cursor ??= await init();
      const start = cursor;
      const rows = await o.store.fetch(cursor - OVERLAP_MS, [...seen.keys()], EVENT_BATCH, ALERT_EVENTS);
      const ctx = rows.length ? await o.context(rows) : null;
      let sent = 0;
      for (const row of rows) {
        const at = row.createdAt.getTime();
        seen.set(row.id, at);
        cursor = Math.max(cursor, at);
        const alert = toAlert(row, ctx!);
        // a failed delivery is logged by `send` and dropped: one dead endpoint must not hold back the rest
        if (alert) {
          await o.send(alert);
          sent++;
        }
      }
      for (const [id, at] of seen) if (at < cursor - OVERLAP_MS) seen.delete(id);
      // saved after the batch: a crash mid-batch resends it, and receivers drop repeats by `id`
      if (cursor !== start) await o.store.saveCursor(cursor);
      return sent;
    },
  };
};

export interface HealthState {
  value: bigint;
  since: Date;
}

export interface HealthStore {
  load(): Promise<Map<HealthKind, HealthState>>;
  save(kind: HealthKind, value: bigint): Promise<Date>; // returns the change time
}

/** Persists each condition on change and sends an alert when `shouldFire`. Unknown readings (undefined) change nothing. */
export const createHealthRunner = (o: { store: HealthStore; context: () => ActivityContext; send: ((a: Alert) => Promise<void>) | null }) => ({
  apply: async (readings: Partial<Record<HealthKind, bigint>>): Promise<HealthKind[]> => {
    const prev = await o.store.load();
    const fired: HealthKind[] = [];
    for (const [kind, next] of Object.entries(readings) as [HealthKind, bigint | undefined][]) {
      if (next === undefined) continue;
      const before = prev.get(kind)?.value ?? 0n;
      if (next === before) continue;
      const since = await o.store.save(kind, next);
      if (shouldFire(kind, before, next)) {
        fired.push(kind);
        if (o.send) await o.send(healthAlert(kind, next, since, o.context()));
      }
    }
    return fired;
  },
});
