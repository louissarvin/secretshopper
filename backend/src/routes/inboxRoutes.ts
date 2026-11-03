import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { inboxAuth, inboxCompanyId } from '../middlewares/inboxAuth.ts';
import { handleNotFoundError, handleServerError } from '../utils/errorHandler.ts';
import { cuidSchema, hex32Schema, parseOr400 } from '../utils/validation.ts';

// Cursor is the (receivedAt, id) of the last item the agent processed; both or neither.
const nextSchema = z
  .object({ afterAt: z.iso.datetime().optional(), afterId: hex32Schema.optional() })
  .strict()
  .refine((q) => !q.afterAt === !q.afterId, 'afterAt and afterId go together');
const vendorParams = z.object({ id: cuidSchema }).strict();

export const inboxRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/next', { preHandler: [inboxAuth] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = await parseOr400(nextSchema, request.query, reply);
    if (!q.ok) return;
    try {
      const cid = await inboxCompanyId(request); // the token's own company only (v2/37 section 4)
      if (!cid) return reply.code(200).send({ success: true, error: null, data: null });
      const afterAt = q.data.afterAt ? new Date(q.data.afterAt) : null;
      const row = await prismaQuery.invoice.findFirst({
        where: {
          companyId: cid,
          deliverAt: { lte: new Date() },
          ...(afterAt
            ? { OR: [{ deliverAt: { gt: afterAt } }, { deliverAt: afterAt, invoiceId: { gt: q.data.afterId } }] }
            : {}),
        },
        orderBy: [{ deliverAt: 'asc' }, { invoiceId: 'asc' }],
        // explicit select: nothing that could link to tests
        select: { invoiceId: true, document: true, email: true, deliverAt: true },
      });
      return reply.code(200).send({
        success: true,
        error: null,
        data: row && { id: row.invoiceId, receivedAt: row.deliverAt.toISOString(), email: row.email, document: row.document },
      });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  // Which vault this token serves, so an agent can refuse a token issued for another vault.
  app.get('/whoami', { preHandler: [inboxAuth] }, async (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(200).send({ success: true, error: null, data: { shop: request.inboxShop } })
  );

  // Vendor identity only. Approved payees come from the vault's get_payees (B11), never from this DB.
  app.get('/vendors/:id', { preHandler: [inboxAuth] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = await parseOr400(vendorParams, request.params, reply);
    if (!params.ok) return;
    try {
      const cid = await inboxCompanyId(request); // the token's own company only (v2/37 section 4)
      const v = cid
        ? await prismaQuery.vendor.findFirst({ where: { id: params.data.id, companyId: cid }, select: { id: true, legalName: true, contactEmail: true } })
        : null;
      if (!v) return handleNotFoundError(reply, 'Vendor');
      return reply.code(200).send({ success: true, error: null, data: v });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  done();
};
