import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { requireCompanyOwner } from '../middlewares/companyContext.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import { limitSchema, parseOr400 } from '../utils/validation.ts';
import { jsonSafe } from '../utils/jsonSafe.ts';

const listSchema = z
  .object({
    limit: limitSchema,
    status: z.enum(['Pending', 'Approved', 'Rejected']).optional(),
    before: z.coerce.number().int().min(0).optional(),
  })
  .strict();

// Indexed proposals; approve and reject are signed in the owner's wallet, not here.
export const proposalRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/', { preHandler: [authMiddleware, requireCompanyOwner] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = await parseOr400(listSchema, request.query, reply);
    if (!q.ok) return;
    try {
      const rows = await prismaQuery.proposal.findMany({
        where: {
          companyId: request.company!.id,
          ...(q.data.status ? { status: q.data.status } : {}),
          ...(q.data.before !== undefined ? { proposalId: { lt: q.data.before } } : {}),
        },
        orderBy: { proposalId: 'desc' },
        take: q.data.limit,
        select: { proposalId: true, invoiceId: true, payee: true, amount: true, status: true, receiptId: true, txHash: true, blockHeight: true, createdAt: true },
      });
      const nextBefore = rows.length === q.data.limit ? rows[rows.length - 1].proposalId : null;
      return reply.code(200).send({ success: true, error: null, data: jsonSafe({ items: rows, nextBefore }) });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  done();
};
