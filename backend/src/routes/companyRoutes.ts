import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { getStatus } from '../lib/near/shop.ts';
import { NEAR } from '../lib/near/client.ts';
import { firstReceivedTx } from '../lib/near/events.ts';
import { vaultChain } from '../lib/near/vaultChain.ts';
import { checkSelfServe } from '../lib/registration.ts';
import { registry } from '../lib/registry.ts';
import { chainBudget } from '../lib/vaults.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { requireCompanyOwner, shopFromRequest } from '../middlewares/companyContext.ts';
import { ALERT_EVENTS, ALERT_KINDS, healthActivity, toActivity } from '../lib/alerts/map.ts';
import { healthStore } from '../lib/alerts/stores.ts';
import { alertToken } from '../lib/alerts/token.ts';
import { MAX_COMPANIES_PER_USER, SHOP_CONTRACT_ID, VAULT_CODE_HASH } from '../config/main-config.ts';
import { handleConflictError, handleError, handleForbiddenError, handleServerError, handleUpstreamError } from '../utils/errorHandler.ts';
import { accountIdSchema, cuidSchema, limitSchema, parseOr400 } from '../utils/validation.ts';
import { jsonSafe } from '../utils/jsonSafe.ts';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    shopId: accountIdSchema.optional(),
    deployBlock: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,15}$/)]).optional(),
  })
  .strict();

const renameSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

const alertsQuery = z.object({ limit: limitSchema, before: cuidSchema.optional() }).strict();
// test_revealed is alert-worthy only when Failed; the other alert events always are
const alertWhere = (shop: string) => ({
  contractId: shop,
  OR: [
    { event: { in: ALERT_EVENTS.filter((e) => e !== 'test_revealed') } },
    { event: 'test_revealed', data: { path: ['status'], equals: 'Failed' } },
  ],
});

// never the inbox token hash
export const companySelect = {
  id: true,
  name: true,
  shopContractId: true,
  vendorAccountId: true,
  deployBlock: true,
  createdTxHash: true,
  createdAt: true,
  testerEnabled: true,
  testPercent: true,
  commitCron: true,
  testerPublicKey: true,
  testerState: true,
  inboxTokenCreatedAt: true,
} as const;

type CompanyRow = { [K in keyof typeof companySelect]: unknown } & { shopContractId: string; inboxTokenCreatedAt: Date | null };

export const companyView = (c: CompanyRow) =>
  jsonSafe({
    id: c.id,
    name: c.name,
    shopContractId: c.shopContractId,
    vendorAccountId: c.vendorAccountId,
    deployBlock: c.deployBlock,
    createdTxHash: c.createdTxHash,
    createdAt: c.createdAt,
    isDefault: c.shopContractId === SHOP_CONTRACT_ID,
    tester: { enabled: c.testerEnabled, testPercent: c.testPercent, commitCron: c.commitCron, publicKey: c.testerPublicKey, state: c.testerState },
    inboxTokenSet: c.inboxTokenCreatedAt !== null,
  });

const createLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const tokenLimit = { rateLimit: { max: 5, timeWindow: '1 minute' } };
const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export const companyRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // The caller's company for the selected vault (X-Shop, default SHOP_CONTRACT_ID), or null.
  app.get('/me', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const sel = shopFromRequest(request);
    if (!sel.ok) return handleError(reply, 400, 'Invalid input: X-Shop', 'VALIDATION_ERROR', null, { fields: ['X-Shop'] });
    try {
      const company = await prismaQuery.company.findFirst({ where: { ownerUserId: request.user!.id, shopContractId: sel.shop }, select: companySelect });
      return reply.code(200).send({ success: true, error: null, data: company ? companyView(company) : null });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  app.get('/mine', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rows = await prismaQuery.company.findMany({ where: { ownerUserId: request.user!.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100, select: companySelect });
      return reply.code(200).send({ success: true, error: null, data: { items: rows.map(companyView) } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  // Registers a vault. Only its on-chain owner may. The default vault keeps the legacy body (deployBlock from the client).
  app.post('/', { preHandler: [authMiddleware], config: createLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = await parseOr400(createSchema, request.body, reply);
    if (!parsed.ok) return;
    const { name, deployBlock } = parsed.data;
    const shopId = parsed.data.shopId ?? SHOP_CONTRACT_ID;
    const legacy = shopId === SHOP_CONTRACT_ID;
    if (legacy && deployBlock === undefined) return handleError(reply, 400, 'Invalid input: deployBlock', 'VALIDATION_ERROR', null, { fields: ['deployBlock'] });
    // a client block is never trusted for a self-serve vault: too high silently loses events
    if (!legacy && deployBlock !== undefined) return handleError(reply, 400, 'Invalid input: deployBlock (derived by the server for a self-serve vault)', 'VALIDATION_ERROR', null, { fields: ['deployBlock'] });

    let data: { vendorAccountId: string; deployBlock: bigint; createdTxHash: string | null };
    if (legacy) {
      let status;
      try {
        status = await getStatus(SHOP_CONTRACT_ID);
      } catch (error) {
        return handleUpstreamError(reply, 'NEAR RPC', error as Error);
      }
      if (status.owner_id !== request.user!.walletAddress) return handleForbiddenError(reply, 'Only the vault owner can register the company');
      try {
        if (await prismaQuery.company.findUnique({ where: { shopContractId: SHOP_CONTRACT_ID }, select: { id: true } })) return handleConflictError(reply, 'Company already registered');
      } catch (error) {
        return handleServerError(reply, error as Error);
      }
      data = { vendorAccountId: status.vendor_id, deployBlock: BigInt(deployBlock!), createdTxHash: null };
    } else {
      if (!chainBudget.take()) return handleError(reply, 503, 'Too many vault lookups right now, retry in a minute', 'VAULT_READS_BUSY');
      let r;
      try {
        r = await checkSelfServe(shopId, { id: request.user!.id, wallet: request.user!.walletAddress }, {
          chain: vaultChain,
          codeHash: VAULT_CODE_HASH,
          firstReceivedTx,
          registered: async (s) => !!(await prismaQuery.company.findUnique({ where: { shopContractId: s }, select: { id: true } })),
          companiesOf: (userId) => prismaQuery.company.count({ where: { ownerUserId: userId } }),
          maxCompanies: MAX_COMPANIES_PER_USER,
        });
      } catch (error) {
        return handleUpstreamError(reply, 'Chain lookup', error as Error);
      }
      if (!r.ok) return handleError(reply, r.status, r.message, r.code, null, { shopId });
      data = { vendorAccountId: r.vendorAccountId, deployBlock: r.deployBlock, createdTxHash: r.createdTxHash };
    }
    try {
      const company = await prismaQuery.company.create({ data: { ownerUserId: request.user!.id, name, shopContractId: shopId, ...data }, select: companySelect });
      registry.invalidate();
      request.log.info({ shop: shopId, selfServe: !legacy }, 'company registered');
      return reply.code(201).send({ success: true, error: null, data: companyView(company) });
    } catch (error) {
      if (isUniqueViolation(error)) return handleConflictError(reply, 'Company already registered');
      return handleServerError(reply, error as Error);
    }
  });

  // One agent inbox token per vault; calling again rotates it. The plaintext is returned once and never logged.
  app.post('/inbox-token', { preHandler: [authMiddleware, requireCompanyOwner], config: tokenLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const token = `ssi_${randomBytes(32).toString('base64url')}`;
    const createdAt = new Date();
    try {
      await prismaQuery.company.update({ where: { id: request.company!.id }, data: { inboxTokenHash: sha256hex(token), inboxTokenCreatedAt: createdAt }, select: { id: true } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
    request.log.info({ shop: request.company!.shopContractId }, 'inbox token issued');
    return reply.code(201).send({ success: true, error: null, data: { token, shopContractId: request.company!.shopContractId, createdAt: createdAt.toISOString() } });
  });

  app.patch('/', { preHandler: [authMiddleware, requireCompanyOwner], config: tokenLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = await parseOr400(renameSchema, request.body, reply);
    if (!parsed.ok) return;
    try {
      const company = await prismaQuery.company.update({ where: { id: request.company!.id }, data: { name: parsed.data.name }, select: companySelect });
      return reply.send({ success: true, error: null, data: companyView(company) });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  // Activity feed with the same texts the webhook sends, so the dashboard works without a webhook.
  app.get('/alerts', { preHandler: [authMiddleware, requireCompanyOwner] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = await parseOr400(alertsQuery, request.query, reply);
    if (!q.ok) return;
    const shop = request.company!.shopContractId;
    try {
      const rows = await prismaQuery.contractEvent.findMany({
        where: alertWhere(shop),
        orderBy: [{ blockHeight: 'desc' }, { logIndex: 'desc' }, { id: 'desc' }],
        take: q.data.limit,
        ...(q.data.before ? { cursor: { id: q.data.before }, skip: 1 } : {}),
        select: { id: true, txHash: true, blockHeight: true, blockTime: true, event: true, data: true },
      });
      const token = rows.some((r) => r.event === 'proposed') ? await alertToken(shop) : undefined;
      const items = rows.flatMap((r) => {
        const item = toActivity(r, { vault: shop, network: NEAR.network, token });
        return item && ALERT_KINDS.has(item.kind) ? [item] : [];
      });
      const nextBefore = rows.length === q.data.limit ? rows[rows.length - 1].id : null;
      // active conditions from the health worker, newest change first; not paged (at most one per kind)
      const ctx = { vault: shop, network: NEAR.network };
      const health = [...(await healthStore(shop).load())]
        .filter(([, h]) => h.value > 0n)
        .map(([kind, h]) => healthActivity(kind, h.value, h.since, ctx))
        .sort((a, b) => b.at.localeCompare(a.at));
      return reply.code(200).send({ success: true, error: null, data: { items, nextBefore, health } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  done();
};
