import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { requireCompanyOwner } from '../middlewares/companyContext.ts';
import { handleNotFoundError, handleServerError } from '../utils/errorHandler.ts';
import { accountIdSchema, cuidSchema, jsonObjectSchema, limitSchema, parseOr400, railSchema } from '../utils/validation.ts';

const payeeSchema = z.object({ account: accountIdSchema, rail: railSchema }).strict();
const fields = {
  legalName: z.string().trim().min(1).max(200),
  contactEmail: z.email().max(254),
  approvedPayees: z.array(payeeSchema).max(20),
  sampleInvoices: z.array(jsonObjectSchema(16 * 1024)).max(5),
  // published with every revealed test (SS-B05): only redacted or synthetic samples belong here
  styleSet: z.array(jsonObjectSchema(16 * 1024)).max(5).default([]),
};
const createSchema = z.object(fields).strict();
const updateSchema = z.object({ ...fields, styleSet: z.array(jsonObjectSchema(16 * 1024)).max(5) }).partial().strict();
const listSchema = z.object({ limit: limitSchema, cursor: cuidSchema.optional() }).strict();
const idParams = z.object({ id: cuidSchema }).strict();

type StoredPayee = { account: string; rail: string; addedAt: string };

// Keep the original addedAt of payees that stay on the list; the record shows when each was approved.
const withAddedAt = (next: z.infer<typeof payeeSchema>[], prev: StoredPayee[] = []): StoredPayee[] => {
  const now = new Date().toISOString();
  return next.map((p) => ({ ...p, addedAt: prev.find((q) => q.account === p.account && q.rail === p.rail)?.addedAt ?? now }));
};

const vendorSelect = { id: true, legalName: true, contactEmail: true, approvedPayees: true, sampleInvoices: true, styleSet: true, createdAt: true, updatedAt: true };

export const vendorRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  const pre = { preHandler: [authMiddleware, requireCompanyOwner] };

  app.get('/', pre, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = await parseOr400(listSchema, request.query, reply);
    if (!q.ok) return;
    try {
      const rows = await prismaQuery.vendor.findMany({
        where: { companyId: request.company!.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: q.data.limit,
        ...(q.data.cursor ? { cursor: { id: q.data.cursor }, skip: 1 } : {}),
        select: vendorSelect,
      });
      const nextCursor = rows.length === q.data.limit ? rows[rows.length - 1].id : null;
      return reply.code(200).send({ success: true, error: null, data: { items: rows, nextCursor } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  app.post('/', pre, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = await parseOr400(createSchema, request.body, reply);
    if (!parsed.ok) return;
    try {
      const vendor = await prismaQuery.vendor.create({
        data: {
          ...parsed.data,
          sampleInvoices: parsed.data.sampleInvoices as Prisma.InputJsonValue,
          styleSet: parsed.data.styleSet as Prisma.InputJsonValue,
          approvedPayees: withAddedAt(parsed.data.approvedPayees),
          companyId: request.company!.id,
        },
        select: vendorSelect,
      });
      request.log.info({ vendorId: vendor.id, payees: parsed.data.approvedPayees.length }, 'vendor created');
      return reply.code(201).send({ success: true, error: null, data: vendor });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  app.put('/:id', pre, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = await parseOr400(idParams, request.params, reply);
    if (!params.ok) return;
    const parsed = await parseOr400(updateSchema, request.body, reply);
    if (!parsed.ok) return;
    try {
      // scoped to the caller's company: no cross-tenant updates by id
      const current = await prismaQuery.vendor.findFirst({ where: { id: params.data.id, companyId: request.company!.id } });
      if (!current) return handleNotFoundError(reply, 'Vendor');
      const { approvedPayees, sampleInvoices, styleSet, ...rest } = parsed.data;
      const vendor = await prismaQuery.vendor.update({
        where: { id: current.id },
        data: {
          ...rest,
          ...(sampleInvoices ? { sampleInvoices: sampleInvoices as Prisma.InputJsonValue } : {}),
          ...(styleSet ? { styleSet: styleSet as Prisma.InputJsonValue } : {}),
          ...(approvedPayees ? { approvedPayees: withAddedAt(approvedPayees, current.approvedPayees as StoredPayee[]) } : {}),
        },
        select: vendorSelect,
      });
      // payee changes are the security-relevant edit; keep an audit line
      if (approvedPayees) request.log.info({ vendorId: vendor.id, payees: approvedPayees.map((p) => p.account) }, 'vendor payees updated');
      return reply.code(200).send({ success: true, error: null, data: vendor });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  done();
};
