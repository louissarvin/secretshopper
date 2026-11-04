// Pure: commit timing from chain time. The contract judges batch_interval and the tlock round by block time,
// so a host clock that runs slow or fast must not decide either (a wrong round is refused on every retry).

export const SKEW_WARN_MS = 30_000;

/** The contract's "next batch not due" check, against the final block time (the commit block is never earlier). */
export const commitDue = (lastCommittedAtNs: string | null, batchIntervalNs: string, chainFinalMs: number): { due: boolean; dueNs: bigint | null } => {
  if (lastCommittedAtNs === null) return { due: true, dueNs: null };
  const dueNs = BigInt(lastCommittedAtNs) + BigInt(batchIntervalNs);
  return { due: BigInt(chainFinalMs) * 1_000_000n >= dueNs, dueNs };
};

/** Host minus chain time, when it is large enough to log. Final blocks trail the head by a few seconds. */
export const clockSkew = (hostMs: number, chainFinalMs: number): number | null => {
  const skew = hostMs - chainFinalMs;
  return Math.abs(skew) > SKEW_WARN_MS ? skew : null;
};
