/**
 * Bounded TTL cache owned by one route (NF-04): a full cache evicts its least recently used entry,
 * so attacker-chosen keys never flush another route's entries. Failures are not cached.
 */
export const createLru = <T>(max: number, ttlMs: number, now: () => number = Date.now) => {
  if (!Number.isInteger(max) || max < 1) throw new Error('lru needs a positive integer size');
  const store = new Map<string, { at: number; value: Promise<T> }>();
  const fresh = (key: string) => {
    const hit = store.get(key);
    if (hit && now() - hit.at < ttlMs) return hit;
    if (hit) store.delete(key);
    return undefined;
  };
  return {
    /** True when `key` would be served without calling its loader. */
    has: (key: string): boolean => !!fresh(key),
    get: (key: string, load: () => Promise<T>): Promise<T> => {
      const hit = fresh(key);
      if (hit) {
        store.delete(key); // re-insert: Map order is recency order
        store.set(key, hit);
        return hit.value;
      }
      if (store.size >= max) store.delete(store.keys().next().value!);
      const value = load();
      const entry = { at: now(), value };
      store.set(key, entry);
      value.catch(() => store.get(key) === entry && store.delete(key));
      return value;
    },
    get size(): number {
      return store.size;
    },
  };
};
