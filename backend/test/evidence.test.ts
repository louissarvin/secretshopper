import { describe, expect, test } from 'bun:test';
import { buildEvidence, type EvidenceReceipt } from '../src/lib/evidence.ts';

const base = {
  network: 'testnet',
  shop: 'shop.owner.testnet',
  batches: [{ batchIndex: 0, firstSlot: 0, count: 2, txHash: 'TX', signerId: 'owner.testnet' }],
  genLog: [],
  invoices: [{ invoiceId: '1'.repeat(64), document: { n: 1 }, email: { s: 'x' }, deliverAt: new Date('2026-11-02T10:00:00Z') }],
  receipts: [],
};
const slot = (i: number, revealed: boolean) => ({
  slotIndex: i,
  status: revealed ? 'Failed' : 'Committed',
  revealedAt: revealed ? new Date() : null,
  revealedSalt: revealed ? 'a'.repeat(64) : null,
  revealedPayee: revealed ? 'f'.repeat(64) : null,
  revealedInvoiceId: revealed ? '1'.repeat(64) : null,
  receiptHash: null,
  revealTxHash: revealed ? 'RTX' : null,
  sweptTxHash: null,
});

describe('evidence bundle', () => {
  test('unrevealed slots carry only index and status', () => {
    const b = buildEvidence({ ...base, slots: [slot(1, false)] });
    expect(b.slots).toEqual([{ slot: 1, status: 'Committed' }]);
  });

  test('revealed slots carry the preimage, the invoice as delivered and pointers', () => {
    const b = buildEvidence({ ...base, slots: [slot(0, true)] });
    expect(b.slots[0].preimage).toEqual({ salt: 'a'.repeat(64), payee: 'f'.repeat(64), invoice_id: '1'.repeat(64), receipt_hash: '0'.repeat(64) });
    expect(b.slots[0].invoice?.deliver_at).toBe('2026-11-02T10:00:00.000Z');
    expect(b.batches[0]).toMatchObject({ batch: 0, tx: 'TX', signer_id: 'owner.testnet', gen_log: null });
  });

  test('gateway receipts are labelled partial, provider_tee without attestation is signer consistency only', () => {
    const rh = 'c'.repeat(64);
    const receipt = (kind: string): EvidenceReceipt => ({
      response_id: 'r',
      model: 'm',
      signature_kind: kind,
      signing_algo: 'ecdsa',
      signing_address: '0x' + '1'.repeat(40),
      signed_text: 't',
      signature: '0x' + '2'.repeat(130),
      request_body: '{}',
      response_body: '{}',
    });
    for (const [kind, label] of [['gateway', 'partial'], ['provider_tee', 'signer_consistency']] as const) {
      const b = buildEvidence({ ...base, slots: [{ ...slot(0, true), receiptHash: rh }], receipts: [{ receiptHash: rh, receipt: receipt(kind) }] });
      expect(b.slots[0].receipt?.assurance).toBe(label);
    }
  });
});
