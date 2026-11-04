/** Maps with at most `limit` promises in flight; results keep input order. */
export const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> => {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};
