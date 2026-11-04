import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { requireCompanyOwner } from '../middlewares/companyContext.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import { limitSchema, parseOr400 } from '../utils/validation.ts';
import { slotSelect, toSlotView, VISIBLE_STATUSES } from '../utils/slotView.ts';

const listSchema = z.object({ limit: limitSchema, before: z.coerce.number().int().min(0).optional() }).strict();

// Owner view. Sealed slots show index, commitment and expiry only, even to the owner's browser.
export const testRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/', { preHandler: [authMiddleware, requireCompanyOwner] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = await parseOr400(listSchema, request.query, reply);
    if (!q.ok) return;
    try {
      const rows = await prismaQuery.testSlot.findMany({
        where: {
          companyId: request.company!.id,
          status: { in: VISIBLE_STATUSES },
          slotIndex: q.data.before !== undefined ? { lt: q.data.before } : { not: null },
        },
        orderBy: { slotIndex: 'desc' },
        take: q.data.limit,
        select: slotSelect,
      });
      const items = rows.map(toSlotView);
      const nextBefore = rows.length === q.data.limit ? rows[rows.length - 1].slotIndex : null;
      return reply.code(200).send({ success: true, error: null, data: { items, nextBefore } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  done();
};
