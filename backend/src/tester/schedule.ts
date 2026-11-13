// Multi-vault: one commit cron per vault, reconciled as settings change. Config-free so tests need no env.

export interface StoppableTask {
  stop: () => void;
}

/** Only `M H * * *`: at most hourly; the contract's batch_interval still decides when a batch is due. */
export const COMMIT_CRON_RE = /^([0-5]?\d) ([0-9*,/-]+) \* \* \*$/;

export interface CommitSchedule {
  shop: string;
  cron: string;
}

/** Adds, replaces (cron changed) and stops commit tasks so `current` matches `wanted`. Mutates `current`. */
export const reconcileCommits = (
  current: Map<string, { cron: string; task: StoppableTask }>,
  wanted: CommitSchedule[],
  schedule: (s: CommitSchedule) => StoppableTask
): { added: string[]; replaced: string[]; stopped: string[] } => {
  const out = { added: [] as string[], replaced: [] as string[], stopped: [] as string[] };
  const want = new Map(wanted.map((w) => [w.shop, w.cron]));
  for (const [shop, cur] of current) {
    if (!want.has(shop)) {
      cur.task.stop();
      current.delete(shop);
      out.stopped.push(shop);
    }
  }
  for (const [shop, cron] of want) {
    const cur = current.get(shop);
    if (cur && cur.cron === cron) continue;
    cur?.task.stop();
    current.set(shop, { cron, task: schedule({ shop, cron }) });
    (cur ? out.replaced : out.added).push(shop);
  }
  return out;
};
