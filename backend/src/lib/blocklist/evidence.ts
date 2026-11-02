// Blocklist evidence check. Pure: the tx's vault events and the vault's revealed slots come in through
// `EvidenceReads`. A report is accepted only when the chain itself ties the account to a lure:
//   failed_reveal     the tx revealed a slot as Failed whose payee is the account
//   paid_lure         the tx paid the account from the vault, and a slot naming the account was revealed Failed
//   declined_invoice  the tx declined an invoice that a revealed slot shows was a lure paying the account

export type EvidenceKind = 'failed_reveal' | 'paid_lure' | 'declined_invoice';

export interface VaultEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface RevealedSlot {
  slotId: number;
  status: string;
  payee: string;
  invoiceId: string;
}

export interface EvidenceReads {
  /** Events from the vault's successful receipts in the tx; null when the tx is unknown (yet). */
  txVaultEvents(txHash: string): Promise<VaultEvent[] | null>;
  revealedSlots(): Promise<RevealedSlot[]>;
}

export type EvidenceVerdict = { ok: true; kind: EvidenceKind; slotId: number } | { ok: false; reason: string };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const verifyEvidence = async (accountId: string, txHash: string, reads: EvidenceReads): Promise<EvidenceVerdict> => {
  const events = await reads.txVaultEvents(txHash);
  if (events === null) return { ok: false, reason: 'transaction not found; retry once it is final and indexed' };
  if (!events.length) return { ok: false, reason: 'the transaction has no successful event from this vault' };

  for (const e of events) {
    if (e.event === 'test_revealed' && str(e.data.status) === 'Failed' && str(e.data.payee) === accountId && typeof e.data.slot_id === 'number')
      return { ok: true, kind: 'failed_reveal', slotId: e.data.slot_id };
  }

  const paid = events.filter((e) => e.event === 'paid' && str(e.data.payee) === accountId);
  const declined = events.map((e) => (e.event === 'declined' ? str(e.data.invoice_id) : null)).filter((x): x is string => !!x);
  if (!paid.length && !declined.length) return { ok: false, reason: 'the transaction neither revealed a Failed lure for this account, nor paid it, nor declined an invoice' };

  const slots = await reads.revealedSlots();
  if (paid.length) {
    const failed = slots.find((s) => s.status === 'Failed' && s.payee === accountId);
    if (failed) return { ok: true, kind: 'paid_lure', slotId: failed.slotId };
  }
  for (const invoiceId of declined) {
    const lure = slots.find((s) => s.invoiceId === invoiceId && s.payee === accountId);
    if (lure) return { ok: true, kind: 'declined_invoice', slotId: lure.slotId };
  }
  return {
    ok: false,
    reason: paid.length
      ? 'the vault paid this account, but no revealed test names it as a Failed lure payee'
      : 'the declined invoice is not a revealed lure for this account',
  };
};
