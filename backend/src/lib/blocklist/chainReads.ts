import { baseDecode } from 'near-api-js';
import { fetchTransactions, parseTxEvents } from '../near/events.ts';
import { getAllTests } from '../near/shop.ts';
import type { EvidenceReads, RevealedSlot, VaultEvent } from './evidence.ts';

// Chain reads for verifyEvidence: the tx through the FastNEAR tx API (no signer needed, the indexer's source),
// slots from the vault's own get_tests. Shared by the API and the tester.

const STANDARD = 'secret_shopper';
const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** A NEAR tx hash: base58 of 32 bytes. */
export const isTxHash = (s: string): boolean => {
  if (!TX_HASH_RE.test(s)) return false;
  try {
    return baseDecode(s).length === 32;
  } catch {
    return false;
  }
};

export const evidenceReads = (vault: string): EvidenceReads => ({
  async txVaultEvents(txHash): Promise<VaultEvent[] | null> {
    if (!isTxHash(txHash)) return null;
    const [tx] = await fetchTransactions([txHash]);
    if (!tx) return null;
    return parseTxEvents(tx, vault, STANDARD).map((r) => ({ event: r.event, data: r.data as Record<string, unknown> }));
  },
  async revealedSlots(): Promise<RevealedSlot[]> {
    return (await getAllTests(vault)).flatMap((t, slotId) => (t.reveal ? [{ slotId, status: t.status, payee: t.reveal.payee, invoiceId: t.reveal.invoice_id }] : []));
  },
});
