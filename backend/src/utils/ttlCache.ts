// Tiny in-process cache so public pages do not turn into one RPC call per visitor.
const store = new Map<string, { at: number; value: Promise<unknown> }>();
const MAX_ENTRIES = 500;

export const cached = <T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> => {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  if (store.size >= MAX_ENTRIES) store.clear();
  const value = load();
  store.set(key, { at: Date.now(), value });
  value.catch(() => store.delete(key)); // never cache failures
  return value;
};
