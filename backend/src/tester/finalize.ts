import type { Prisma } from '../../prisma/generated/client.js';
import type { ChainTestSlot } from '../lib/near/shop.ts';
import { publicSlotRow, type Sealed } from './slots.ts';

export interface FinalizeItem {
  rowId: string;
  slotIndex: number;
  chain: ChainTestSlot;
  s: Sealed;
}

/**
 * The DB half of finalize, inside one transaction. Each Prepared row is claimed with a conditional update first:
 * a concurrent finalize blocks on that row lock and then claims nothing, so it delivers nothing twice (B23-09).
 * The batch tx and signer are recorded whoever claimed the slots. Returns the number of slots claimed.
 */
export const finalizeInTx = async (
  tx: Prisma.TransactionClient,
  p: { cid: string; items: FinalizeItem[]; times: Date[]; batchIndex: number; expiresAt: Date; batchTx: { txHash: string; signerId: string } | null }
): Promise<number> => {
  let k = 0;
  let claimed = 0;
  for (const o of p.items) {
    const won = await tx.sealedSlot.updateMany({
      where: { id: o.rowId, status: 'Prepared' },
      data: { slotIndex: o.slotIndex, batchIndex: p.batchIndex, status: 'Committed', expiresAt: p.expiresAt },
    });
    if (won.count === 0) continue;
    claimed++;
    if (o.s.invoice && k < p.times.length) {
      await tx.invoice.create({
        data: { companyId: p.cid, invoiceId: o.s.invoiceId, document: o.s.invoice.document as Prisma.InputJsonValue, email: o.s.invoice.email, deliverAt: p.times[k++] },
        select: { id: true },
      });
    }
    // public row: only what the chain already shows
    const pub = publicSlotRow(o.chain);
    await tx.testSlot.upsert({
      where: { companyId_slotIndex: { companyId: p.cid, slotIndex: o.slotIndex } },
      create: { companyId: p.cid, slotIndex: o.slotIndex, ...pub },
      update: pub,
    });
  }
  if (p.batchTx) {
    const first = p.items[0].slotIndex;
    await tx.testBatch.upsert({
      where: { companyId_batchIndex: { companyId: p.cid, batchIndex: p.batchIndex } },
      create: { companyId: p.cid, batchIndex: p.batchIndex, firstSlot: first, count: p.items.length, txHash: p.batchTx.txHash, signerId: p.batchTx.signerId, expiresAt: p.expiresAt },
      update: { txHash: p.batchTx.txHash, signerId: p.batchTx.signerId, expiresAt: p.expiresAt },
    });
  }
  return claimed;
};
