// Evidence bundle (B10): only bytes whose hashes are on chain, plus pointers (tx hashes) a verifier re-reads from chain.
// scripts/verify-evidence.ts never trusts a value here that the chain can provide.
import { verifyReceiptAgainstAttestation, type StoredAttestation } from './proof/attestation.ts';
import { assuranceNote, assuranceOf, type AiReceiptBytes, type ReceiptAssurance } from './proof/receipt.ts';

export interface EvidenceReceipt {
  response_id: string;
  model: string;
  signature_kind: string;
  signing_algo: string;
  signing_address: string;
  signed_text: string;
  signature: string;
  request_body: string;
  response_body: string;
  attestation?: StoredAttestation; // binds the signer to a TEE; absent on receipts published before ai_receipts.attestation
  assurance?: ReceiptAssurance; // set by buildEvidence; verify-evidence recomputes it
  assurance_note?: string;
}

const toBytes = (r: EvidenceReceipt): AiReceiptBytes => ({
  responseId: r.response_id,
  model: r.model,
  signatureKind: r.signature_kind as AiReceiptBytes['signatureKind'],
  signingAlgo: r.signing_algo,
  signingAddress: r.signing_address,
  signedText: r.signed_text,
  signature: r.signature,
  requestBody: r.request_body,
  responseBody: r.response_body,
});

/** Gateway receipts are always labelled partial; provider_tee is attested only if the stored attestation binds. */
export const labelReceipt = (r: EvidenceReceipt): EvidenceReceipt => {
  const kind = r.signature_kind === 'provider_tee' ? 'provider_tee' : 'gateway';
  const bound = !!r.attestation && verifyReceiptAgainstAttestation(toBytes(r), r.attestation).ok;
  const assurance = assuranceOf(kind, bound);
  return { ...r, assurance, assurance_note: assuranceNote(assurance) };
};

export type ReceiptRow = Omit<AiReceiptBytes, 'signatureKind'> & { signatureKind: string; attestation: unknown; createdAt: Date };

// The raw report (~200 KB) stays in the evidence bundle; the slot view carries the binding result and a summary.
export const receiptView = ({ attestation, ...r }: ReceiptRow) => {
  const kind = r.signatureKind === 'provider_tee' ? 'provider_tee' : 'gateway';
  const stored = (attestation ?? null) as StoredAttestation | null;
  const bound = !!stored && verifyReceiptAgainstAttestation({ ...r, signatureKind: kind }, stored).ok;
  const assurance = assuranceOf(kind, bound);
  const summary = stored
    ? {
        kind: stored.kind,
        bound,
        signer: stored.signer,
        tcbStatus: stored.tcbStatus,
        advisoryIds: stored.advisoryIds,
        deploymentProvenance: stored.deploymentProvenance,
        gpuEvidence: stored.kind === 'model' ? stored.gpuEvidence : null,
        verifiedAt: stored.verifiedAt,
      }
    : null;
  return { ...r, assurance, assuranceNote: assuranceNote(assurance), attestation: summary };
};

export interface EvidenceSlot {
  slot: number;
  status: string; // as last indexed; the verifier reads the chain status
  preimage?: { salt: string; payee: string; invoice_id: string; receipt_hash: string };
  invoice?: { document: unknown; email: unknown; deliver_at: string };
  receipt?: EvidenceReceipt;
  reveal_tx?: string | null;
  sweep_tx?: string | null;
}

export interface EvidenceBatch {
  batch: number;
  first_slot: number;
  count: number;
  tx: string | null; // commit_batch tx: its args carry the tlock ciphertexts
  signer_id: string | null;
  gen_log: { position: number; receipt_hash: string; model: string; accepted: boolean }[] | null; // null until the batch is fully revealed
}

export interface EvidenceBundle {
  version: 1;
  network: string;
  shop: string;
  generated_at: string;
  batches: EvidenceBatch[];
  slots: EvidenceSlot[];
  next_from_slot: number | null; // the API pages slots (B23-01); null on the last page and in files
}

export interface EvidenceInput {
  network: string;
  shop: string;
  batches: { batchIndex: number; firstSlot: number; count: number; txHash: string | null; signerId: string | null }[];
  genLog: { batchIndex: number; position: number; receiptHash: string; model: string; accepted: boolean }[];
  slots: {
    slotIndex: number;
    status: string;
    revealedAt: Date | null;
    revealedSalt: string | null;
    revealedPayee: string | null;
    revealedInvoiceId: string | null;
    receiptHash: string | null;
    revealTxHash: string | null;
    sweptTxHash: string | null;
  }[];
  invoices: { invoiceId: string; document: unknown; email: unknown; deliverAt: Date }[];
  receipts: { receiptHash: string; receipt: EvidenceReceipt }[];
  nextFromSlot?: number | null;
}

/** Slots per evidence page (B23-01); pages start at multiples of it. */
export const EVIDENCE_PAGE = 100;

/** Cuts `rows` (slot order, from `fromSlot`, at most EVIDENCE_PAGE + 1) to one page and the next non-empty page start. */
export const pageOfSlots = <T extends { slotIndex: number }>(rows: T[], fromSlot: number): { slots: T[]; nextFromSlot: number | null } => {
  const end = fromSlot + EVIDENCE_PAGE;
  const after = rows.find((s) => s.slotIndex >= end);
  return { slots: rows.filter((s) => s.slotIndex >= fromSlot && s.slotIndex < end), nextFromSlot: after ? Math.floor(after.slotIndex / EVIDENCE_PAGE) * EVIDENCE_PAGE : null };
};

const ZERO = '0'.repeat(64);

/** Unrevealed slots carry only their index and status; content appears after reveal. */
export const buildEvidence = (i: EvidenceInput, now = new Date()): EvidenceBundle => {
  const inv = new Map(i.invoices.map((x) => [x.invoiceId, x]));
  const rec = new Map(i.receipts.map((r) => [r.receiptHash, r.receipt]));
  return {
    version: 1,
    network: i.network,
    shop: i.shop,
    generated_at: now.toISOString(),
    batches: i.batches
      .sort((a, b) => a.batchIndex - b.batchIndex)
      .map((b) => {
        const log = i.genLog.filter((g) => g.batchIndex === b.batchIndex).sort((x, y) => x.position - y.position);
        return {
          batch: b.batchIndex,
          first_slot: b.firstSlot,
          count: b.count,
          tx: b.txHash,
          signer_id: b.signerId,
          gen_log: log.length ? log.map((g) => ({ position: g.position, receipt_hash: g.receiptHash, model: g.model, accepted: g.accepted })) : null,
        };
      }),
    slots: i.slots
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((s): EvidenceSlot => {
        const revealed = s.revealedAt !== null && s.revealedSalt !== null && s.revealedInvoiceId !== null && s.revealedPayee !== null;
        if (!revealed) return { slot: s.slotIndex, status: 'Committed' };
        const receiptHash = s.receiptHash ?? ZERO;
        const invoice = inv.get(s.revealedInvoiceId!);
        const receipt = receiptHash !== ZERO ? rec.get(receiptHash) : undefined;
        return {
          slot: s.slotIndex,
          status: s.status,
          preimage: { salt: s.revealedSalt!, payee: s.revealedPayee!, invoice_id: s.revealedInvoiceId!, receipt_hash: receiptHash },
          ...(invoice ? { invoice: { document: invoice.document, email: invoice.email, deliver_at: invoice.deliverAt.toISOString() } } : {}),
          ...(receipt ? { receipt: labelReceipt(receipt) } : {}),
          reveal_tx: s.revealTxHash,
          sweep_tx: s.sweptTxHash,
        };
      }),
    next_from_slot: i.nextFromSlot ?? null,
  };
};
