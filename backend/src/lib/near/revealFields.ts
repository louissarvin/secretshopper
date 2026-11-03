// Pure so the projector rule is testable without a database or RPC.

/**
 * Reveal tx and time for a slot first projected from `ev`. A `test_revealed` event in a later block than the
 * chain's reveal comes from `prove_delivery`, so its tx is not the reveal tx (B23-10); the reveal tx stays unknown.
 */
export const revealFields = (
  ev: { txHash: string; blockTime: Date },
  chainRevealAtNs: string | null
): { revealTxHash: string | null; revealedAt: Date } => {
  if (chainRevealAtNs === null) return { revealTxHash: ev.txHash, revealedAt: ev.blockTime };
  const revealedAt = new Date(Number(BigInt(chainRevealAtNs) / 1_000_000n));
  return { revealTxHash: revealedAt.getTime() === ev.blockTime.getTime() ? ev.txHash : null, revealedAt };
};
