import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { NEAR } from '../lib/near/client.ts';
import { getPolicy, getScorecard, getStatus, type Policy, type Scorecard, type Status } from '../lib/near/shop.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { shopFromRequest } from '../middlewares/companyContext.ts';
import { handleError, handleForbiddenError, handleServerError, handleUpstreamError } from '../utils/errorHandler.ts';
import { cuidSchema, limitSchema, parseOr400 } from '../utils/validation.ts';
import { cached } from '../utils/ttlCache.ts';
import { dateToNs, VENDOR_EVENTS, vendorView } from '../lib/vendorView.ts';
import { toActivity } from '../lib/alerts/map.ts';

const VIEW_TTL_MS = 5_000;
const vendorLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
// failed armings (ok:false) added no key; skip a few of them to find the last real one
const ARMED_LOOKBACK = 10;
const armedData = z.object({ public_key: z.string(), ok: z.boolean().optional() });
const lastArmedKey = (rows: { data: unknown }[]): string | null => {
  for (const r of rows) {
    const d = armedData.safeParse(r.data);
    if (d.success && d.data.ok !== false) return d.data.public_key;
  }
  return null;
};
const historyQuery = z.object({ limit: limitSchema, before: cuidSchema.optional() }).strict();

declare module 'fastify' {
  interface FastifyRequest {
    vendorShop?: string;
  }
}

export interface VendorChain {
  status: (shop: string) => Promise<Status>;
  policy: (shop: string) => Promise<Policy>;
  scorecard: (shop: string) => Promise<Scorecard>;
}

// keyed by shop; only registered vaults reach these (requireVendor), so the shared cache stays bounded
const liveChain: VendorChain = {
  status: (shop) => cached(`vendor:status:${shop}`, VIEW_TTL_MS, () => getStatus(shop)),
  policy: (shop) => cached(`vendor:policy:${shop}`, VIEW_TTL_MS, () => getPolicy(shop)),
  scorecard: (shop) => cached(`scorecard:${shop}`, VIEW_TTL_MS, () => getScorecard(shop)),
};

/** Routes for the vault's agent vendor; `chain` is injectable so tests need no RPC. */
export const createVendorConsoleRoutes =
  (chain: VendorChain = liveChain): FastifyPluginCallback =>
  (app: FastifyInstance, _opts, done) => {
    // X-Shop selects the vault (default SHOP_CONTRACT_ID). It must be registered, so this is not an open RPC proxy; the
    // vendor is whoever the contract says, read live, so a vendor change on chain applies within the cache TTL.
    // a function declaration keeps its name, which the route-registry test reads
    async function requireVendor(request: FastifyRequest, reply: FastifyReply): Promise<true | FastifyReply> {
      const sel = shopFromRequest(request);
      if (!sel.ok) return handleError(reply, 400, 'Invalid input: X-Shop', 'VALIDATION_ERROR', null, { fields: ['X-Shop'] });
      try {
        if (!(await prismaQuery.company.findUnique({ where: { shopContractId: sel.shop }, select: { id: true } }))) return handleError(reply, 404, 'Company is not registered yet', 'COMPANY_NOT_FOUND');
      } catch (error) {
        return handleServerError(reply, error as Error);
      }
      let status: Status;
      try {
        status = await chain.status(sel.shop);
      } catch (error) {
        return handleUpstreamError(reply, 'NEAR RPC', error as Error);
      }
      if (request.user?.walletAddress !== status.vendor_id) return handleForbiddenError(reply, 'Only the agent vendor');
      request.vendorShop = sel.shop;
      return true;
    }
    const pre = { preHandler: [authMiddleware, requireVendor], config: vendorLimit };

    // A hint for the web: vaults whose registered vendor is the caller. Every route above re-checks get_status live.
    app.get('/vaults', { preHandler: [authMiddleware], config: vendorLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const items = await prismaQuery.company.findMany({
          where: { vendorAccountId: request.user!.walletAddress },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 100,
          select: { shopContractId: true, name: true },
        });
        return reply.code(200).send({ success: true, error: null, data: { items } });
      } catch (error) {
        return handleServerError(reply, error as Error);
      }
    });

    app.get('/me', pre, async (request: FastifyRequest, reply: FastifyReply) => {
      const shop = request.vendorShop!;
      let views;
      try {
        views = await Promise.all([chain.status(shop), chain.policy(shop), chain.scorecard(shop)]);
      } catch (error) {
        return handleUpstreamError(reply, 'NEAR RPC', error as Error);
      }
      const [status, policy, scorecard] = views;
      try {
        const [proposed, armings] = status.pending_key
          ? await Promise.all([
              // the contract keeps no proposal time; the newest indexed proposal of this exact key has it
              prismaQuery.contractEvent.findFirst({
                where: { contractId: shop, event: 'key_proposed', data: { path: ['public_key'], equals: status.pending_key } },
                orderBy: [{ blockHeight: 'desc' }, { logIndex: 'desc' }],
                select: { blockTime: true },
              }),
              prismaQuery.contractEvent.findMany({
                where: { contractId: shop, event: 'agent_armed' },
                orderBy: [{ blockHeight: 'desc' }, { logIndex: 'desc' }],
                take: ARMED_LOOKBACK,
                select: { data: true },
              }),
            ])
          : [null, []];
        const indexed = { pendingKeyProposedAt: proposed ? dateToNs(proposed.blockTime) : null, lastArmedKey: lastArmedKey(armings) };
        return reply.code(200).send({ success: true, error: null, data: vendorView(shop, NEAR.network, status, policy, scorecard, indexed) });
      } catch (error) {
        return handleServerError(reply, error as Error);
      }
    });

    app.get('/history', pre, async (request: FastifyRequest, reply: FastifyReply) => {
      const q = await parseOr400(historyQuery, request.query, reply);
      if (!q.ok) return;
      const shop = request.vendorShop!;
      try {
        const rows = await prismaQuery.contractEvent.findMany({
          where: { contractId: shop, event: { in: [...VENDOR_EVENTS] } },
          orderBy: [{ blockHeight: 'desc' }, { logIndex: 'desc' }, { id: 'desc' }],
          take: q.data.limit,
          ...(q.data.before ? { cursor: { id: q.data.before }, skip: 1 } : {}),
          select: { id: true, event: true, data: true, txHash: true, blockHeight: true, blockTime: true },
        });
        const ctx = { vault: shop, network: NEAR.network };
        const items = rows.flatMap((r) => toActivity(r, ctx) ?? []);
        const nextBefore = rows.length === q.data.limit ? rows[rows.length - 1].id : null;
        return reply.code(200).send({ success: true, error: null, data: { items, nextBefore } });
      } catch (error) {
        return handleServerError(reply, error as Error);
      }
    });

    done();
  };

export const vendorConsoleRoutes = createVendorConsoleRoutes();
