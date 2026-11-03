import { z } from 'zod';
import { prismaQuery } from '../prisma.ts';
import { getTest, nsToDate, TEST_STATUSES } from './shop.ts';
import { createLogger } from '../../utils/logger.ts';
import { revealFields } from './revealFields.ts';

const log = createLogger('projector');

export interface StoredEvent {
  receiptId: string;
  txHash: string;
  blockHeight: bigint;
  blockTime: Date;
  event: string;
  data: unknown;
}

const u32 = z.number().int().min(0).max(0xffffffff);
const u128 = z.string().regex(/^\d{1,39}$/);
const u64 = z.string().regex(/^\d{1,20}$/);

// Event versions: agent_armed 2.2.0 adds ok (from the AddKey callback; 2.0.0 had none and meant success),
// agent_demoted 2.2.0 drops methods (the swap reports in agent_key_changed), near_withdrawn 2.2.0 adds ok.
const S = {
  agent_armed: z.object({ public_key: z.string(), ok: z.boolean().optional() }),
  agent_demoted: z.object({ slot_id: u32, public_key: z.string() }),
  agent_frozen: z.object({ public_key: z.string().nullable().optional() }),
  agent_key_changed: z.object({ public_key: z.string(), methods: z.string().nullable(), ok: z.boolean() }),
  near_withdrawn: z.object({ amount: u128, ok: z.boolean().optional() }),
  batch_committed: z.object({ batch: u32, first_slot: u32, count: u32, expires_at: u64 }),
  paid: z.object({ payment_id: u32, invoice_id: z.string(), payee: z.string(), amount: u128, rail: z.string(), by_owner: z.boolean() }),
  payment_settled: z.object({ payment_id: u32, ok: z.boolean() }),
  proposed: z.object({ proposal_id: u32, invoice_id: z.string(), payee: z.string(), amount: u128 }),
  proposal_resolved: z.object({ proposal_id: u32, approved: z.boolean() }),
  release_posted: z.object({ release_at: u64, root: z.string().regex(/^[0-9a-f]{64}$/), count: u32 }),
  release_acked: z.object({ release_at: u64, matches: z.boolean() }),
  test_revealed: z.object({
    slot_id: u32,
    status: z.enum(TEST_STATUSES as [string, ...string[]]),
    contained: z.boolean(),
    payee: z.string(),
    invoice_id: z.string(),
  }),
};

const KEY_ROLE = { agent_armed: 'Pay', agent_demoted: 'Propose', agent_frozen: 'Deleted' } as const;

/**
 * Projects one raw event into the read tables. Idempotent (upserts keyed by on-chain ids).
 * Returns false when it depends on an event not projected yet; the projector retries it next tick.
 */
export const applyEvent = async (companyId: string, shopId: string, ev: StoredEvent): Promise<boolean> => {
  const at = { receiptId: ev.receiptId, txHash: ev.txHash, blockHeight: ev.blockHeight };
  switch (ev.event) {
    case 'agent_armed':
    case 'agent_demoted':
    case 'agent_frozen': {
      const d = S[ev.event].parse(ev.data);
      if ('ok' in d && d.ok === false) {
        // AddKey failed: the vault restored its prior mode, so no key changed role
        log.warn('agent arming failed on chain', { receiptId: ev.receiptId, publicKey: d.public_key });
        return true;
      }
      await prismaQuery.agentKey.upsert({
        where: { receiptId_event: { receiptId: ev.receiptId, event: ev.event } },
        create: { companyId, publicKey: d.public_key ?? null, role: KEY_ROLE[ev.event], event: ev.event, ...at },
        update: {},
      });
      return true;
    }
    case 'batch_committed': {
      const d = S.batch_committed.parse(ev.data);
      const expiresAt = nsToDate(d.expires_at);
      await prismaQuery.testBatch.upsert({
        where: { companyId_batchIndex: { companyId, batchIndex: d.batch } },
        create: { companyId, batchIndex: d.batch, firstSlot: d.first_slot, count: d.count, txHash: ev.txHash, expiresAt },
        update: { firstSlot: d.first_slot, count: d.count, txHash: ev.txHash, expiresAt },
      });
      await prismaQuery.testSlot.updateMany({
        where: { companyId, slotIndex: { gte: d.first_slot, lt: d.first_slot + d.count } },
        data: { expiresAt },
      });
      return true;
    }
    case 'paid': {
      const d = S.paid.parse(ev.data);
      await prismaQuery.payment.upsert({
        where: { companyId_paymentId: { companyId, paymentId: d.payment_id } },
        create: {
          companyId,
          paymentId: d.payment_id,
          invoiceId: d.invoice_id,
          payee: d.payee,
          amount: d.amount,
          rail: d.rail,
          byOwner: d.by_owner,
          ...at,
        },
        update: {},
      });
      return true;
    }
    case 'payment_settled': {
      const d = S.payment_settled.parse(ev.data);
      const r = await prismaQuery.payment.updateMany({
        where: { companyId, paymentId: d.payment_id },
        data: { status: d.ok ? 'Settled' : 'Failed' },
      });
      return r.count === 1;
    }
    case 'proposed': {
      const d = S.proposed.parse(ev.data);
      await prismaQuery.proposal.upsert({
        where: { companyId_proposalId: { companyId, proposalId: d.proposal_id } },
        create: { companyId, proposalId: d.proposal_id, invoiceId: d.invoice_id, payee: d.payee, amount: d.amount, ...at },
        update: {},
      });
      return true;
    }
    case 'proposal_resolved': {
      const d = S.proposal_resolved.parse(ev.data);
      const r = await prismaQuery.proposal.updateMany({
        where: { companyId, proposalId: d.proposal_id },
        data: { status: d.approved ? 'Approved' : 'Rejected' },
      });
      return r.count === 1;
    }
    case 'test_revealed': {
      const d = S.test_revealed.parse(ev.data);
      const row = await prismaQuery.testSlot.findFirst({
        where: { companyId, slotIndex: d.slot_id },
        select: { id: true, revealedSalt: true, revealedAt: true },
      });
      if (!row) return true; // slot not created by our tester; nothing to project
      if (d.status === 'Ignored' && row.revealedAt) {
        // prove_delivery re-emits the reveal: only the status changes, the reveal tx and time stay
        await prismaQuery.testSlot.updateMany({ where: { id: row.id }, data: { status: d.status } });
        return true;
      }
      // anyone can reveal; the salt is only in contract state, not in the event
      const chainReveal = row.revealedSalt === null || d.status === 'Ignored' ? ((await getTest(shopId, d.slot_id))?.reveal ?? null) : null;
      const salt = row.revealedSalt ?? chainReveal?.salt ?? null;
      // an Ignored event whose reveal was never projected may be the prove_delivery tx (B23-10)
      const { revealTxHash, revealedAt } = revealFields(ev, d.status === 'Ignored' ? (chainReveal?.at ?? null) : null);
      // updateMany: no RETURNING, so it works under the API role's column grants (prisma/roles.sql)
      await prismaQuery.testSlot.updateMany({
        where: { id: row.id },
        data: {
          status: d.status,
          contained: d.contained,
          revealedPayee: d.payee,
          revealedInvoiceId: d.invoice_id,
          revealedSalt: salt,
          revealTxHash,
          revealedAt,
        },
      });
      return true;
    }
    case 'agent_key_changed': {
      const d = S.agent_key_changed.parse(ev.data);
      // a failed delete means the key was already gone; a failed re-scope leaves get_status.stale_key set
      if (!d.ok && d.methods !== null) log.warn('agent key re-scope failed; anyone may call resync_key', { receiptId: ev.receiptId, publicKey: d.public_key });
      return true;
    }
    case 'near_withdrawn': {
      const d = S.near_withdrawn.parse(ev.data);
      if (d.ok === false) log.warn('NEAR withdrawal failed; the amount went back to the vault', { receiptId: ev.receiptId, amount: d.amount });
      return true;
    }
    case 'release_posted': {
      S.release_posted.parse(ev.data); // the tick is recomputed from invoices; the raw event row is the record
      return true;
    }
    case 'release_acked': {
      const d = S.release_acked.parse(ev.data);
      // a different root is on-chain evidence that the agent saw another inbox than the tester released
      if (!d.matches) log.warn('agent acked a different release root', { receiptId: ev.receiptId, releaseAt: d.release_at });
      return true;
    }
    default:
      // key_proposed, declined, withdrawn: kept as raw events only
      log.debug('raw-only event', { event: ev.event, receiptId: ev.receiptId });
      return true;
  }
};
