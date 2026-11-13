import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { NEAR, view } from '../lib/near/client.ts';
import { getPayeeStatus, getScorecard, getStatus, isPayeeActive } from '../lib/near/shop.ts';
import { handleError, handleNotFoundError, handleServerError, handleUpstreamError } from '../utils/errorHandler.ts';
import { accountIdSchema, limitSchema, parseOr400 } from '../utils/validation.ts';
import { isRevealed, slotSelect, toSlotView, VISIBLE_STATUSES } from '../utils/slotView.ts';
import { ONECLICK_API_URL, ONECLICK_JWT, SHOP_CONTRACT_ID } from '../config/main-config.ts';
import { buildEvidence, EVIDENCE_PAGE, pageOfSlots, receiptView } from '../lib/evidence.ts';
import { receiptHashOf } from '../lib/proof/commitment.ts';
import { type StoredAttestation } from '../lib/proof/attestation.ts';
import { cached } from '../utils/ttlCache.ts';
import { buildLedger, LEDGER_EVENTS, toCsv } from '../lib/ledger.ts';
import { createBudget, dryQuote, listTokens, QuoteInputError, QuoteRejectedError } from '../lib/intents/quote.ts';
import { RELEASE_SETTLE_MS, releaseAtNs, releaseTicks } from '../lib/releases.ts';
import { merkleRootHex } from '../lib/proof/merkle.ts';

const VIEW_TTL_MS = 5_000;

const shopParams = z.object({ shopId: accountIdSchema }).strict();
const slotParams = z.object({ shopId: accountIdSchema, slot: z.coerce.number().int().min(0).max(0xffffffff) }).strict();
const listSchema = z.object({ limit: limitSchema, before: z.coerce.number().int().min(0).optional() }).strict();
const ledgerQuery = z
  .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from < q.to, 'from must be before to');
const ftMetadata = z.object({ symbol: z.string().min(1).max(32), decimals: z.number().int().min(0).max(38) });
// One request reads at most this many events; past it the caller narrows `to`.
const LEDGER_MAX_EVENTS = 20_000;
const ledgerLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const quoteQuery = z
  .object({
    payee: accountIdSchema,
    destinationAsset: z.string(),
    amount: z.string(),
    recipient: z.string(),
    slippageBps: z.coerce.number().int().optional(),
  })
  .strict();
// each quote is one 1Click call once the token list is cached; unauthenticated 1Click traffic is shared by all callers
const quoteLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const TOKENS_TTL_MS = 5 * 60_000;
// B23-04: the partner key is spent only for an active approved payee of this vault, and at most this often overall
const partnerBudget = createBudget(60, 60_000);
const PAYEE_TTL_MS = 60_000;

const releasesQuery = z.object({ since: z.iso.datetime().optional(), limit: limitSchema }).strict();
const RELEASES_DEFAULT_LOOKBACK_MS = 7 * 86_400_000;
// each request is two indexed reads; ids per tick are bounded by what one tick released
const releasesLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

// B23-01: a bundle carries about 16 KB of receipt per revealed lure, so it is paged by slot range and cached per page.
const EVIDENCE_TTL_MS = 30_000;
const evidenceLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };
const evidenceQuery = z.object({ fromSlot: z.coerce.number().int().min(0).max(0xffffffff).multipleOf(EVIDENCE_PAGE).default(0) }).strict();

// Only registered shops, so this is not an open RPC proxy.
const companyFor = (shopId: string) => prismaQuery.company.findUnique({ where: { shopContractId: shopId }, select: { id: true } });

const DECISION_EVENTS = { paid: 'Paid', declined: 'Declined', proposed: 'Proposed' } as const;

/** Chain context for a revealed slot, all from indexed public events: commit tx, decision tx and demotion receipt. */
const slotChainContext = async (companyId: string, shopId: string, slot: number, batchIndex: number | null, invoiceId: string | null) => {
  const [batch, decision, demotion] = await Promise.all([
    batchIndex === null
      ? null
      : prismaQuery.testBatch.findUnique({ where: { companyId_batchIndex: { companyId, batchIndex } }, select: { txHash: true, signerId: true, createdAt: true } }),
    invoiceId
      ? prismaQuery.contractEvent.findFirst({
          where: { contractId: shopId, event: { in: Object.keys(DECISION_EVENTS) }, data: { path: ['invoice_id'], equals: invoiceId } },
          orderBy: { blockHeight: 'asc' },
          select: { event: true, txHash: true, receiptId: true, blockTime: true },
        })
      : null,
    prismaQuery.contractEvent.findFirst({
      where: { contractId: shopId, event: 'agent_demoted', data: { path: ['slot_id'], equals: slot } },
      orderBy: { blockHeight: 'asc' },
      select: { txHash: true, receiptId: true, blockTime: true },
    }),
  ]);
  return {
    commitTx: batch ? { txHash: batch.txHash, signerId: batch.signerId } : null,
    decisionTx: decision ? { kind: DECISION_EVENTS[decision.event as keyof typeof DECISION_EVENTS], txHash: decision.txHash, receiptId: decision.receiptId, at: decision.blockTime } : null,
    demotion: demotion ? { txHash: demotion.txHash, receiptId: demotion.receiptId, at: demotion.blockTime } : null,
  };
};

/** One page of the evidence bundle: slots in [fromSlot, fromSlot + EVIDENCE_PAGE), plus where the next page starts. */
const evidencePage = async (companyId: string, shop: string, fromSlot: number) => {
  const [batches, genLog, rows] = await Promise.all([
    prismaQuery.testBatch.findMany({ where: { companyId }, select: { batchIndex: true, firstSlot: true, count: true, txHash: true, signerId: true } }),
    prismaQuery.genLogEntry.findMany({ where: { companyId }, select: { batchIndex: true, position: true, receiptHash: true, model: true, accepted: true } }),
    prismaQuery.testSlot.findMany({
      where: { companyId, slotIndex: { gte: fromSlot }, status: { in: VISIBLE_STATUSES } },
      orderBy: { slotIndex: 'asc' },
      take: EVIDENCE_PAGE + 1,
      select: { slotIndex: true, status: true, revealedAt: true, revealedSalt: true, revealedPayee: true, revealedInvoiceId: true, receiptHash: true, revealTxHash: true, sweptTxHash: true, aiReceiptId: true },
    }),
  ]);
  const { slots, nextFromSlot } = pageOfSlots(
    rows.map((s) => ({ ...s, slotIndex: s.slotIndex! })),
    fromSlot
  );
  const revealed = slots.filter((s) => s.revealedAt);
  const [invoices, receipts] = await Promise.all([
    prismaQuery.invoice.findMany({
      where: { companyId, invoiceId: { in: revealed.map((s) => s.revealedInvoiceId!).filter(Boolean) } },
      select: { invoiceId: true, document: true, email: true, deliverAt: true },
    }),
    prismaQuery.aiReceipt.findMany({ where: { companyId, id: { in: revealed.map((s) => s.aiReceiptId!).filter(Boolean) } } }),
  ]);
  return buildEvidence({
    network: NEAR.network,
    shop,
    batches,
    genLog,
    slots,
    invoices,
    receipts: receipts.map((r) => ({
      receiptHash: receiptHashOf(r.signedText),
      receipt: {
        response_id: r.responseId,
        model: r.model,
        signature_kind: r.signatureKind,
        signing_algo: r.signingAlgo,
        signing_address: r.signingAddress,
        signed_text: r.signedText,
        signature: r.signature,
        request_body: r.requestBody,
        response_body: r.responseBody,
        ...(r.attestation ? { attestation: r.attestation as unknown as StoredAttestation } : {}),
      },
    })),
    nextFromSlot,
  });
};

// Convenience only: the web reads contract views directly, so the backend is not a trust point for the score.
export const publicRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/config', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const status = await cached(`status:${SHOP_CONTRACT_ID}`, 60_000, () => getStatus(SHOP_CONTRACT_ID));
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          network: NEAR.network,
          explorerUrl: NEAR.explorerUrl,
          shop: SHOP_CONTRACT_ID,
          owner: status.owner_id,
          vendor: status.vendor_id,
          token: status.token_id,
          intents: status.intents_id,
        },
      });
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
  });

  app.get('/scorecard/:shopId', async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(shopParams, request.params, reply);
    if (!p.ok) return;
    try {
      if (!(await companyFor(p.data.shopId))) return handleNotFoundError(reply, 'Shop');
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
    try {
      return reply.code(200).send({ success: true, error: null, data: await cached(`scorecard:${p.data.shopId}`, VIEW_TTL_MS, () => getScorecard(p.data.shopId)) });
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
  });

  app.get('/tests/:shopId', async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(shopParams, request.params, reply);
    if (!p.ok) return;
    const q = await parseOr400(listSchema, request.query, reply);
    if (!q.ok) return;
    try {
      const company = await companyFor(p.data.shopId);
      if (!company) return handleNotFoundError(reply, 'Shop');
      const rows = await prismaQuery.testSlot.findMany({
        where: {
          companyId: company.id,
          status: { in: VISIBLE_STATUSES },
          slotIndex: q.data.before !== undefined ? { lt: q.data.before } : { not: null },
        },
        orderBy: { slotIndex: 'desc' },
        take: q.data.limit,
        select: slotSelect,
      });
      const nextBefore = rows.length === q.data.limit ? rows[rows.length - 1].slotIndex : null;
      return reply.code(200).send({ success: true, error: null, data: { items: rows.map(toSlotView), nextBefore } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  // Revealed tests only: the invoice as the agent saw it and the exact AI receipt bytes.
  app.get('/tests/:shopId/:slot', async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(slotParams, request.params, reply);
    if (!p.ok) return;
    try {
      const company = await companyFor(p.data.shopId);
      if (!company) return handleNotFoundError(reply, 'Shop');
      const row = await prismaQuery.testSlot.findFirst({
        where: { companyId: company.id, slotIndex: p.data.slot, revealedAt: { not: null } },
        select: { ...slotSelect, invoiceRowId: true, aiReceiptId: true, batchIndex: true },
      });
      if (!row || !isRevealed(row)) return handleNotFoundError(reply, 'Revealed test');
      const { invoiceRowId, aiReceiptId, batchIndex, ...slot } = row;
      const [invoice, receipt, chain] = await Promise.all([
        invoiceRowId
          ? prismaQuery.invoice.findUnique({ where: { id: invoiceRowId }, select: { invoiceId: true, document: true, email: true, deliverAt: true } })
          : null,
        aiReceiptId
          ? prismaQuery.aiReceipt.findUnique({
              where: { id: aiReceiptId },
              select: {
                responseId: true,
                model: true,
                signatureKind: true,
                signingAlgo: true,
                signingAddress: true,
                signedText: true,
                signature: true,
                requestBody: true,
                responseBody: true,
                attestation: true,
                createdAt: true,
              },
            })
          : null,
        slotChainContext(company.id, p.data.shopId, p.data.slot, batchIndex, row.revealedInvoiceId),
      ]);
      const labelled = receipt ? receiptView(receipt) : null;
      return reply.code(200).send({ success: true, error: null, data: { ...slot, revealed: true, invoice, receipt: labelled, ...chain } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  // Accountant CSV from indexed chain events (all of it public on chain). Status is as of `to`; rows start at `from`.
  app.get('/ledger/:shopId', { config: ledgerLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(shopParams, request.params, reply);
    if (!p.ok) return;
    const q = await parseOr400(ledgerQuery, request.query, reply);
    if (!q.ok) return;
    const { from, to } = q.data;
    let events;
    try {
      if (!(await companyFor(p.data.shopId))) return handleNotFoundError(reply, 'Shop');
      events = await prismaQuery.contractEvent.findMany({
        where: { contractId: p.data.shopId, event: { in: [...LEDGER_EVENTS] }, ...(to ? { blockTime: { lt: to } } : {}) },
        orderBy: [{ blockHeight: 'asc' }, { logIndex: 'asc' }],
        take: LEDGER_MAX_EVENTS + 1,
        select: { event: true, data: true, txHash: true, blockHeight: true, blockTime: true, logIndex: true },
      });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
    if (events.length > LEDGER_MAX_EVENTS) return handleError(reply, 422, 'Too many events; pass an earlier `to`', 'LEDGER_TOO_LARGE');
    let token;
    try {
      const status = await cached(`status:${p.data.shopId}`, 60_000, () => getStatus(p.data.shopId));
      token = ftMetadata.parse(await cached(`ft_metadata:${status.token_id}`, 3_600_000, () => view<unknown>(status.token_id, 'ft_metadata')));
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
    try {
      const fromUtc = from ? from.toISOString().replace('T', ' ').slice(0, 19) : null;
      const rows = buildLedger(events, { tokenSymbol: token.symbol, decimals: token.decimals, explorerUrl: NEAR.explorerUrl }).filter((r) => !fromUtc || r.date_utc >= fromUtc);
      return reply
        .code(200)
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="ledger-${p.data.shopId}.csv"`)
        .send(toCsv(rows));
    } catch (error) {
      // a malformed indexed amount must not yield a partial ledger
      return handleServerError(reply, error as Error);
    }
  });

  // The partner key (better fee schedule) goes out only for an approved payee; anyone else gets the public fee (B23-04).
  const partnerJwtFor = async (payee: string): Promise<string> => {
    if (!ONECLICK_JWT) return '';
    try {
      const status = await cached(`payee:${SHOP_CONTRACT_ID}:${payee}`, PAYEE_TTL_MS, () => getPayeeStatus(SHOP_CONTRACT_ID, payee));
      if (!status || !isPayeeActive(status, Date.now())) return '';
    } catch (error) {
      app.log.warn({ err: error, payee }, 'payee check failed, quoting without the partner key');
      return '';
    }
    return partnerBudget.take() ? ONECLICK_JWT : '';
  };
  const tokensCached = () => cached(`1click:tokens:${ONECLICK_API_URL}`, TOKENS_TTL_MS, () => listTokens({ baseUrl: ONECLICK_API_URL }));

  // Payout preview for a payee paid on the Intents rail: 1Click dry quote, nothing signed or moved.
  app.get('/quote', { config: quoteLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = await parseOr400(quoteQuery, request.query, reply);
    if (!q.ok) return;
    try {
      const jwt = await partnerJwtFor(q.data.payee);
      const data = await dryQuote(q.data, { jwt, baseUrl: ONECLICK_API_URL, tokens: tokensCached });
      return reply.code(200).send({ success: true, error: null, data }); // feeNote says whether the partner key went out
    } catch (error) {
      if (error instanceof QuoteInputError) return handleError(reply, 400, error.message, 'VALIDATION_ERROR');
      if (error instanceof QuoteRejectedError) return handleError(reply, 400, error.message, 'QUOTE_REJECTED');
      return handleUpstreamError(reply, '1Click', error as Error);
    }
  });

  // Delivery proof: released ticks with their sorted invoice ids, so anyone can recompute the root posted on chain.
  // Closed ticks only (as the tester posts them), never a future tick: that would show when tests land.
  app.get('/releases/:shopId', { config: releasesLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(shopParams, request.params, reply);
    if (!p.ok) return;
    const q = await parseOr400(releasesQuery, request.query, reply);
    if (!q.ok) return;
    try {
      const company = await companyFor(p.data.shopId);
      if (!company) return handleNotFoundError(reply, 'Shop');
      const now = Date.now();
      const since = q.data.since ? new Date(q.data.since) : new Date(now - RELEASES_DEFAULT_LOOKBACK_MS);
      const ticks = await releaseTicks(company.id, since, new Date(now - RELEASE_SETTLE_MS), q.data.limit);
      const items = ticks.map((t) => ({
        releaseAt: t.releaseAt.toISOString(),
        releaseAtNs: releaseAtNs(t.releaseAt),
        count: t.ids.length,
        root: merkleRootHex(t.ids),
        ids: t.ids,
      }));
      const nextSince = ticks.length === q.data.limit ? new Date(ticks[ticks.length - 1].releaseAt.getTime() + 1).toISOString() : null;
      return reply.code(200).send({ success: true, error: null, data: { items, nextSince } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  // B10: everything a verifier needs besides the chain and drand. scripts/verify-evidence.ts re-checks it.
  app.get('/evidence/:shopId', { config: evidenceLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(shopParams, request.params, reply);
    if (!p.ok) return;
    const q = await parseOr400(evidenceQuery, request.query, reply);
    if (!q.ok) return;
    try {
      const company = await companyFor(p.data.shopId);
      if (!company) return handleNotFoundError(reply, 'Shop');
      const { shopId } = p.data;
      const { fromSlot } = q.data;
      const bundle = await cached(`evidence:${shopId}:${fromSlot}`, EVIDENCE_TTL_MS, () => evidencePage(company.id, shopId, fromSlot));
      return reply.code(200).send({ success: true, error: null, data: bundle });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  done();
};
