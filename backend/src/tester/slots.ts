import { randomBytes, randomInt } from 'node:crypto';
import { commitmentOf, ZERO_RECEIPT } from '../lib/proof/commitment.ts';
import { sealForChain } from '../lib/proof/tlock.ts';
import { seal } from './seal.ts';

// Building committed slots. Shared by the tester workers and the local demo.

export type Sealed = {
  salt: string;
  payee: string; // '' for a void slot
  payeeSecret?: string; // key of the test payee, used by the sweep
  payeeKind?: 'near_implicit' | 'eth_implicit';
  invoiceId: string;
  receiptHash: string; // ZERO_RECEIPT for voids
  attemptId?: string; // tester.generation_attempts row, published at reveal
  category?: string;
  invoice?: { document: Record<string, unknown>; email: { from_name: string; from_email: string; subject: string; body: string } };
};

export type BuiltSlot = { commitment: string; sealed: string; plain: Sealed };

/** The commit_batch slot argument (v2 interface). */
export type ChainSlotArg = { commitment: string; tlock_round: number; ciphertext_sha256: string };

const build = (key: Buffer, plain: Sealed): BuiltSlot => ({
  commitment: commitmentOf(plain.salt, plain.payee, plain.invoiceId, plain.receiptHash),
  sealed: seal(key, plain),
  plain,
});

/** A void slot: random invoice id, empty payee, zero receipt. Revealed only after expiry. */
export const makeVoidSlot = (key: Buffer): BuiltSlot =>
  build(key, { salt: randomBytes(32).toString('hex'), payee: '', invoiceId: randomBytes(32).toString('hex'), receiptHash: ZERO_RECEIPT });

/** A test slot for a lure whose invoice id was computed with invoiceIdOf(document) and whose receipt is bound. */
export const makeTestSlot = (key: Buffer, t: Omit<Sealed, 'salt'> & { payee: string }): BuiltSlot =>
  build(key, { ...t, salt: randomBytes(32).toString('hex') });

/**
 * Timelock-encrypts each preimage to `round` (B8). Every slot in a batch uses the same round and the same
 * padded plaintext size, so ciphertexts do not separate tests from voids.
 */
export const sealBatchForChain = async (slots: BuiltSlot[], round: number): Promise<{ args: ChainSlotArg[]; ciphertexts: string[] }> => {
  const sealedCt = await Promise.all(
    slots.map((s) => sealForChain(round, { salt: s.plain.salt, payee: s.plain.payee, invoice_id: s.plain.invoiceId, receipt_hash: s.plain.receiptHash }))
  );
  return {
    args: slots.map((s, i) => ({ commitment: s.commitment, tlock_round: round, ciphertext_sha256: sealedCt[i].ciphertextSha256 })),
    ciphertexts: sealedCt.map((c) => c.ciphertextB64),
  };
};

// Fisher-Yates: positions of tests vs voids carry no meaning
export const shuffle = <T>(xs: T[]): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * SS-B04: the only fields the tester writes to the public tests table at commit time, all already public on chain.
 * Linkage (invoice row, AI receipt, receipt hash) is written only at reveal.
 */
export const publicSlotRow = (c: { commitment: string; expires_at: string; batch: number; tlock_round: number; ciphertext_sha256: string }) => ({
  commitment: c.commitment,
  status: 'Committed',
  expiresAt: new Date(Number(BigInt(c.expires_at) / 1_000_000n)),
  batchIndex: c.batch,
  tlockRound: BigInt(c.tlock_round),
  ciphertextSha256: c.ciphertext_sha256,
});
