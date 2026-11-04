import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { vaultChain } from '../lib/near/vaultChain.ts';
import { TESTER_METHODS } from '../lib/proof/testerKey.ts';
import { checkEnable, isCommitCron } from '../lib/testerOnboarding.ts';
import { registry } from '../lib/registry.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { requireCompanyOwner } from '../middlewares/companyContext.ts';
import { SHOP_CONTRACT_ID, TESTER_ALLOWANCE_YOCTO, TESTER_MAX_BATCH_SIZE, TESTER_MAX_VAULTS, TESTER_MIN_ALLOWANCE_YOCTO } from '../config/main-config.ts';
import { handleError, handleNotFoundError, handleServerError, handleUpstreamError } from '../utils/errorHandler.ts';
import { accountIdSchema, parseOr400 } from '../utils/validation.ts';
import { cached } from '../utils/ttlCache.ts';

// Tester onboarding (v2/37 section 6): what key to add, and the owner's opt-in. The tester process writes the public
// key and state; this API only reads them and never sees the seed.

const shopParams = z.object({ shopId: accountIdSchema }).strict();
const putBody = z
  .object({
    enabled: z.boolean(),
    testPercent: z.number().int().min(0).max(100).optional(),
    commitCron: z.string().max(64).refine(isCommitCron, 'M H * * * (at most hourly)').nullable().optional(),
  })
  .strict();
const readLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const putLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const OWNER_TTL_MS = 60_000;

const testerSelect = { id: true, shopContractId: true, testerEnabled: true, testerPublicKey: true, testerState: true, testPercent: true, commitCron: true, testerCheckedAt: true } as const;
type TesterRow = { shopContractId: string; testerEnabled: boolean; testerPublicKey: string | null; testerState: string | null };

const ownerOf = (shop: string) =>
  cached(`tester-owner:${shop}`, OWNER_TTL_MS, async () => {
    const s = await vaultChain.view<{ owner_id: string }>(shop, 'get_status');
    if (!s) throw new Error(`get_status of ${shop} is not readable`);
    return s.owner_id;
  });

const publicView = async (c: TesterRow) => ({
  shopId: c.shopContractId,
  signerId: await ownerOf(c.shopContractId),
  publicKey: c.testerPublicKey,
  receiverId: c.shopContractId,
  methods: [...TESTER_METHODS],
  allowanceYocto: TESTER_ALLOWANCE_YOCTO.toString(),
  minAllowanceYocto: TESTER_MIN_ALLOWANCE_YOCTO.toString(),
  enabled: c.testerEnabled,
  state: c.testerPublicKey ? c.testerState : 'provisioning',
});

/** GET /public/tester/:shopId: registered vaults only. */
export const testerPublicRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/tester/:shopId', { config: readLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(shopParams, request.params, reply);
    if (!p.ok) return;
    let c;
    try {
      c = await prismaQuery.company.findUnique({ where: { shopContractId: p.data.shopId }, select: testerSelect });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
    if (!c) return handleNotFoundError(reply, 'Shop');
    try {
      return reply.code(200).send({ success: true, error: null, data: await publicView(c) });
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
  });
  done();
};

/** GET and PUT /company/tester: the owner, vault selected by X-Shop. */
export const testerCompanyRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  const pre = [authMiddleware, requireCompanyOwner];

  app.get('/tester', { preHandler: pre, config: readLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    let c;
    try {
      c = (await prismaQuery.company.findUnique({ where: { id: request.company!.id }, select: testerSelect }))!;
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
    try {
      const view = await publicView(c);
      return reply.code(200).send({ success: true, error: null, data: { ...view, testPercent: c.testPercent, commitCron: c.commitCron, testerCheckedAt: c.testerCheckedAt } });
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
  });

  app.put('/tester', { preHandler: pre, config: putLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const b = await parseOr400(putBody, request.body, reply);
    if (!b.ok) return;
    const company = request.company!;
    // the default vault's tester settings live in .env.tester
    if (company.shopContractId === SHOP_CONTRACT_ID) return handleError(reply, 409, 'The default vault is configured in the tester environment', 'DEFAULT_VAULT_ENV');
    const settings = { ...(b.data.testPercent !== undefined ? { testPercent: b.data.testPercent } : {}), ...(b.data.commitCron !== undefined ? { commitCron: b.data.commitCron } : {}) };

    let data: Record<string, unknown> = { ...settings, testerEnabled: b.data.enabled };
    if (b.data.enabled) {
      let row, vendorCount, enabledOthers;
      try {
        [row, vendorCount, enabledOthers] = await Promise.all([
          prismaQuery.company.findUnique({ where: { id: company.id }, select: { testerPublicKey: true, testerEnabled: true } }),
          prismaQuery.vendor.count({ where: { companyId: company.id } }),
          prismaQuery.company.count({ where: { testerEnabled: true, id: { not: company.id }, shopContractId: { not: SHOP_CONTRACT_ID } } }),
        ]);
      } catch (error) {
        return handleServerError(reply, error as Error);
      }
      let r;
      try {
        r = await checkEnable({
          chain: vaultChain,
          shop: company.shopContractId,
          publicKey: row!.testerPublicKey,
          vendorCount,
          enabledOthers,
          minAllowanceYocto: TESTER_MIN_ALLOWANCE_YOCTO,
          maxBatchSize: TESTER_MAX_BATCH_SIZE,
          maxVaults: TESTER_MAX_VAULTS,
        });
      } catch (error) {
        return handleUpstreamError(reply, 'NEAR RPC', error as Error);
      }
      if (!r.ok) return handleError(reply, r.status, r.message, r.code, null, { shop: company.shopContractId });
      // capacity order: keep the first enable time across re-enables of an enabled vault
      data = { ...data, testerSignerId: r.signerId, ...(row!.testerEnabled ? {} : { testerEnabledAt: new Date() }) };
    }
    try {
      // only columns ss_api may update (prisma/roles.sql, v2/37)
      const c = await prismaQuery.company.update({ where: { id: company.id }, data, select: testerSelect });
      registry.invalidate();
      request.log.info({ shop: company.shopContractId, enabled: c.testerEnabled }, 'tester settings changed');
      const view = await publicView(c).catch(() => null);
      return reply.code(200).send({ success: true, error: null, data: { ...(view ?? { shopId: c.shopContractId, enabled: c.testerEnabled }), testPercent: c.testPercent, commitCron: c.commitCron, testerCheckedAt: c.testerCheckedAt } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });
  done();
};
