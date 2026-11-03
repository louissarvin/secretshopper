import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { BLOCKLIST_TRUSTED_VAULTS } from '../config/main-config.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { requireCompanyOwner } from '../middlewares/companyContext.ts';
import { inboxAuth } from '../middlewares/inboxAuth.ts';
import { verifyEvidence } from '../lib/blocklist/evidence.ts';
import { evidenceReads, isTxHash } from '../lib/blocklist/chainReads.ts';
import { entriesFor, listEntries, recordEntry, type ReporterKind } from '../lib/blocklist/store.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { handleError, handleServerError, handleUpstreamError } from '../utils/errorHandler.ts';
import { accountIdSchema, cuidSchema, limitSchema, parseOr400 } from '../utils/validation.ts';
import { createLru } from '../utils/lruCache.ts';

// Shared payee blocklist. Reports come from this vault's owner or agent and are accepted only with on-chain evidence
// (lib/blocklist/evidence.ts); the tester adds its Failed reveals itself. Reads are public.

const reportBody = z
  .object({
    accountId: accountIdSchema,
    // shown publicly; control characters would only serve to spoof lines in logs or exports
    reason: z.string().trim().min(1).max(280).refine((s) => ![...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f), 'no control characters'),
    evidenceTx: z.string().refine(isTxHash, 'a NEAR transaction hash (base58, 32 bytes)'),
  })
  .strict();
const accountParams = z.object({ accountId: accountIdSchema }).strict();
const listQuery = z.object({ limit: limitSchema, before: cuidSchema.optional() }).strict();

// each report reads the tx and possibly every slot of the vault
const reportLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const readLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };
const READ_TTL_MS = 5_000;
// route-owned caches: account ids are attacker-chosen (NF-04)
const accountCache = createLru<Awaited<ReturnType<typeof entriesFor>>>(256, READ_TTL_MS);
const listCache = createLru<Awaited<ReturnType<typeof listEntries>>>(64, READ_TTL_MS);

// evidence is read on, and the entry recorded for, the reporter's own vault (v2/37 section 7)
const report = async (request: FastifyRequest, reply: FastifyReply, reporter: { kind: ReporterKind; id: string; vault: string }) => {
  const b = await parseOr400(reportBody, request.body, reply);
  if (!b.ok) return;
  const { accountId, reason, evidenceTx } = b.data;
  let existing;
  try {
    existing = await prismaQuery.blocklistEntry.findUnique({ where: { accountId_evidenceTx: { accountId, evidenceTx } }, select: { id: true } });
  } catch (error) {
    return handleServerError(reply, error as Error);
  }
  let verdict;
  try {
    // an entry already listed was verified when it went in; repeating the report reads nothing from chain
    if (!existing) verdict = await verifyEvidence(accountId, evidenceTx, evidenceReads(reporter.vault));
  } catch (error) {
    return handleUpstreamError(reply, 'Chain lookup', error as Error);
  }
  if (verdict && !verdict.ok) return handleError(reply, 422, verdict.reason, 'EVIDENCE_REJECTED', null, { accountId, evidenceTx, reporter: reporter.kind });
  try {
    const kind = verdict?.ok ? verdict.kind : 'failed_reveal'; // ignored when the entry already exists
    const { created, entry } = await recordEntry({ accountId, reason, evidenceTx, evidenceKind: kind, reporterKind: reporter.kind, reporterId: reporter.id, vault: reporter.vault });
    request.log.info({ accountId, evidenceTx, kind: entry.evidenceKind, reporter: reporter.kind, created }, 'blocklist report');
    return reply.code(created ? 201 : 200).send({ success: true, error: null, data: { created, entry } });
  } catch (error) {
    return handleServerError(reply, error as Error);
  }
};

const lookup = async (request: FastifyRequest, reply: FastifyReply, vaults?: string[]) => {
  const p = await parseOr400(accountParams, request.params, reply);
  if (!p.ok) return;
  try {
    const key = `${p.data.accountId}|${vaults?.join(',') ?? '*'}`;
    const entries = await accountCache.get(key, () => entriesFor(p.data.accountId, vaults));
    return reply.code(200).send({ success: true, error: null, data: { accountId: p.data.accountId, listed: entries.length > 0, count: entries.length, entries } });
  } catch (error) {
    return handleServerError(reply, error as Error);
  }
};

/** POST /blocklist: the vault owner (NEP-413 JWT). */
export const blocklistRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post('/', { preHandler: [authMiddleware, requireCompanyOwner], config: reportLimit }, (request, reply) =>
    report(request, reply, { kind: 'owner', id: request.user!.walletAddress, vault: request.company!.shopContractId })
  );
  done();
};

/** POST /inbox/blocklist and GET /inbox/blocklist/:accountId: the agent, with its inbox token. */
export const blocklistInboxRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post('/blocklist', { preHandler: [inboxAuth], config: reportLimit }, (request, reply) =>
    report(request, reply, { kind: 'agent', id: `agent:${request.inboxShop}`, vault: request.inboxShop! })
  );
  // an agent counts only evidence from its own vault and the operator's trusted ones (ADR-6)
  app.get('/blocklist/:accountId', { preHandler: [inboxAuth], config: readLimit }, (request, reply) =>
    lookup(request, reply, [...new Set([request.inboxShop!, ...BLOCKLIST_TRUSTED_VAULTS])].sort())
  );
  done();
};

/** GET /public/blocklist and GET /public/blocklist/:accountId. */
export const blocklistPublicRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/blocklist', { config: readLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = await parseOr400(listQuery, request.query, reply);
    if (!q.ok) return;
    try {
      const page = await listCache.get(`${q.data.limit}:${q.data.before ?? ''}`, () => listEntries(q.data.limit, q.data.before));
      return reply.code(200).send({ success: true, error: null, data: page });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });
  app.get('/blocklist/:accountId', { config: readLimit }, (request, reply) => lookup(request, reply));
  done();
};
