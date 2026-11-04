import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { getDecision } from '../lib/near/shop.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { requireCompanyOwner } from '../middlewares/companyContext.ts';
import { RELEASE_TICK_MINUTES } from '../config/main-config.ts';
import { handleConflictError, handleNotFoundError, handleServerError } from '../utils/errorHandler.ts';
import { cuidSchema, limitSchema, parseOr400 } from '../utils/validation.ts';
import { documentSchema, emailSchema } from '../utils/intake.ts';
import { invoiceIdOf } from '../utils/canonical.ts';
import { nextRealDelivery } from '../utils/delivery.ts';
import { mapLimit } from '../utils/concurrency.ts';

export { emailSchema } from '../utils/intake.ts';

const createSchema = z
  .object({
    vendorId: cuidSchema,
    document: documentSchema,
    email: emailSchema,
  })
  .strict();

const listSchema = z.object({ limit: limitSchema, cursor: cuidSchema.optional() }).strict();

export const invoiceRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  const pre = { preHandler: [authMiddleware, requireCompanyOwner] };

  // Real invoice intake. Same id rule and release rule as tests, so the inbox cannot tell them apart.
  app.post('/', pre, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = await parseOr400(createSchema, request.body, reply);
    if (!parsed.ok) return;
    const { vendorId, document, email } = parsed.data;
    try {
      const vendor = await prismaQuery.vendor.findFirst({ where: { id: vendorId, companyId: request.company!.id }, select: { id: true } });
      if (!vendor) return handleNotFoundError(reply, 'Vendor');
      const doc = { ...document, vendor_id: vendor.id };
      const invoiceId = invoiceIdOf(doc);
      const exists = await prismaQuery.invoice.findUnique({ where: { invoiceId }, select: { id: true } });
      if (exists) return handleConflictError(reply, 'An identical invoice already exists');
      const row = await prismaQuery.invoice.create({
        data: { companyId: request.company!.id, invoiceId, document: doc as Prisma.InputJsonValue, email, deliverAt: nextRealDelivery(new Date(), RELEASE_TICK_MINUTES) },
        select: { invoiceId: true, deliverAt: true },
      });
      request.log.info({ invoiceId, vendorId }, 'invoice queued');
      return reply.code(201).send({ success: true, error: null, data: row });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  // Owner inbox: delivered invoices with their on-chain decision (read live from the contract).
  app.get('/', pre, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = await parseOr400(listSchema, request.query, reply);
    if (!q.ok) return;
    try {
      const rows = await prismaQuery.invoice.findMany({
        where: { companyId: request.company!.id, deliverAt: { lte: new Date() } },
        orderBy: [{ deliverAt: 'desc' }, { id: 'desc' }],
        take: q.data.limit,
        ...(q.data.cursor ? { cursor: { id: q.data.cursor }, skip: 1 } : {}),
        select: { id: true, invoiceId: true, document: true, email: true, deliverAt: true },
      });
      const decisions = await mapLimit(rows, 5, (r) => getDecision(request.company!.shopContractId, r.invoiceId));
      const items = rows.map((r, i) => {
        const d = decisions[i];
        return {
          invoiceId: r.invoiceId,
          deliverAt: r.deliverAt,
          document: r.document,
          email: r.email,
          decision: d.status === 'fulfilled' ? d.value : null,
          decisionUnavailable: d.status === 'rejected',
        };
      });
      const nextCursor = rows.length === q.data.limit ? rows[rows.length - 1].id : null;
      return reply.code(200).send({ success: true, error: null, data: { items, nextCursor } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  done();
};
