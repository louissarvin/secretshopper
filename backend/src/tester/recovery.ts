// SS-B07: a Prepared slot is abandoned only when its commit tx can no longer land and the chain shows no such slot.
// A NEAR tx references a recent block hash and expires after transaction_validity_period blocks
// (86,400 blocks, about 14 h at 0.6 s); 26 h leaves margin for slower block times.
export const TX_VALIDITY_MS = 26 * 60 * 60 * 1000;

export const shouldAbandon = (createdAt: Date, nowMs: number, onChain: boolean): boolean => !onChain && nowMs - createdAt.getTime() > TX_VALIDITY_MS;

/** Every recurring tester job and its cron; recovery runs at startup and on this schedule. */
export const TESTER_SCHEDULES = {
  reveal: '*/30 * * * * *',
  release: '*/30 * * * * *', // RELEASE_SETTLE_MS after a tick, then within 30 s
  recover: '*/10 * * * *',
  sweep: '*/10 * * * *',
  keys: '* * * * *', // v2/37: write each company's tester public key
  vaults: '*/5 * * * *', // v2/37: reload vaults, preflight, reconcile commit crons
} as const;
