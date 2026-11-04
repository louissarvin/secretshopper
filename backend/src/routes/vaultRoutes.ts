import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { NEAR } from '../lib/near/client.ts';
import { firstIncomingTxHash } from '../lib/near/events.ts';
import { vaultChain } from '../lib/near/vaultChain.ts';
import { buildVaultPlan, type PlanConfig } from '../lib/vault/plan.ts';
import { DEFAULT_POLICY, minFunding, POLICY_BOUNDS } from '../lib/vault/policy.ts';
import { readVault, type VaultRead } from '../lib/vault/view.ts';
import { chainBudget } from '../lib/vaults.ts';
import { VAULT_CODE_HASH, VAULT_DEFAULT_TOKEN_ID, VAULT_PLAN_MAINNET } from '../config/main-config.ts';
import { handleUpstreamError } from '../utils/errorHandler.ts';
import { accountIdSchema, parseOr400 } from '../utils/validation.ts';
import { cached } from '../utils/ttlCache.ts';
import { createLru } from '../utils/lruCache.ts';
import { createLogger, errFields } from '../utils/logger.ts';

const log = createLogger('vault-routes');

// Self-serve vaults: any wallet can create a vault from the published global contract, then see it live.
// Read-only: the API builds unsigned transactions and reads public chain state; it never signs or stores anything.

const planConfig: PlanConfig = { network: NEAR.network, codeHash: VAULT_CODE_HASH, defaultTokenId: VAULT_DEFAULT_TOKEN_ID, allowMainnet: VAULT_PLAN_MAINNET };
const planEnabled = !!VAULT_CODE_HASH && (NEAR.network === 'testnet' || VAULT_PLAN_MAINNET);

const TEMPLATE_TTL_MS = 60_000;
const VAULT_TTL_MS = 5_000;
// each plan is about six RPC reads; each vault view four
const planLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const vaultLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const vaultParams = z.object({ shopId: accountIdSchema }).strict();

const NOTES = [
  'One wallet transaction creates `<name>.<ownerId>`, funds it, attaches the global contract by code hash and calls `new`; the vault never holds an access key.',
  'A second transaction registers the vault on the token (storage_deposit), so it can hold and pay tokens.',
  'Policy amounts: daily_cap and max_per_payment in token base units. The default caps are 6-decimal units (tUSDC) and a plan scales them to the chosen token; NEAR values in yoctoNEAR, times in nanoseconds.',
  'Self-serve plans need payee_delay of at least 1 hour, so the owner cannot delist a payee and frame the agent in one block.',
  'The Intents rail is off (intents_id null): NEAR Intents has no testnet deployment.',
  'The plan comes from public chain state. The API signs nothing and stores nothing; check every action in the wallet before approving.',
];

// NF-04: attacker-chosen ids get their own bounded caches (never the shared one), and uncached chain reads share a budget.
const VIEW_CACHE_SIZE = 256;
const viewCache = createLru<VaultRead>(VIEW_CACHE_SIZE, VAULT_TTL_MS);
const createdCache = createLru<string | null>(VIEW_CACHE_SIZE, VAULT_TTL_MS);

/** Expected client errors on these public routes: logged to stdout only, no ErrorLog row (NF-04). */
const quietError = (reply: FastifyReply, status: number, code: string, message: string, details: Record<string, unknown> | null = null, context: Record<string, unknown> = {}) => {
  log.warn(message, { reqId: reply.request.id, statusCode: status, errorCode: code, path: reply.request.routeOptions?.url, ...context });
  return reply.code(status).send({ success: false, error: { ...details, code, message }, data: null, timestamp: new Date().toISOString() });
};
const busy = (reply: FastifyReply) => quietError(reply, 503, 'VAULT_READS_BUSY', 'Too many vault lookups right now, retry in a minute');

const STATUS: Record<string, number> = { VALIDATION_ERROR: 400, VAULT_EXISTS: 409, VAULT_PLAN_DISABLED: 403, VAULT_PLAN_REFUSED: 422 };

// NF-07: the first tx the account received. For a vault made by our plan that is its creation tx; a failed tx sent
// to the name earlier would show instead (verify-evidence applies the strict V21-04 check). Found hashes never change.
const createdTxs = new Map<string, string>();
const createdTxOf = async (vaultId: string): Promise<string | null> => {
  const hit = createdTxs.get(vaultId);
  if (hit) return hit;
  try {
    const hash = await firstIncomingTxHash(vaultId);
    if (hash && createdTxs.size < 1_000) createdTxs.set(vaultId, hash);
    return hash;
  } catch (error) {
    log.warn('creation tx lookup failed', { vaultId, ...errFields(error) });
    return null;
  }
};

export const vaultRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/vault-template', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const codePublished = VAULT_CODE_HASH ? await cached(`vault-code:${VAULT_CODE_HASH}`, TEMPLATE_TTL_MS, () => vaultChain.globalCodePublished(VAULT_CODE_HASH)) : false;
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          network: NEAR.network,
          codeHash: VAULT_CODE_HASH || null,
          codePublished,
          planEnabled: planEnabled && codePublished,
          defaultTokenId: VAULT_DEFAULT_TOKEN_ID || null,
          defaultPolicy: DEFAULT_POLICY,
          policyBounds: POLICY_BOUNDS,
          minFundingYocto: minFunding({ kind: 'global', codeHash: new Uint8Array(32) }, DEFAULT_POLICY).toString(),
          notes: NOTES,
        },
      });
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
  });

  app.post('/vault-plan', { config: planLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!chainBudget.take()) return busy(reply);
    let result;
    try {
      result = await buildVaultPlan(request.body, planConfig, vaultChain);
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
    if (result.ok) return reply.code(200).send({ success: true, error: null, data: result.plan });
    const { problems, vaultId } = result;
    const fields = problems.filter((p) => p.field).map((p) => ({ field: p.field!, message: p.message }));
    const message = result.malformed ? `Invalid input: ${[...new Set(fields.map((f) => f.field))].join(', ')}` : problems.map((p) => p.message).join('; ');
    const details = result.code === 'VAULT_PLAN_DISABLED' ? null : { fields, ...(vaultId ? { vaultId } : {}) };
    return quietError(reply, STATUS[result.code], result.code, message, details, { problems });
  });

  // Any account, registered or not: only vaults running the configured global code are shown.
  app.get('/vault/:shopId', { config: vaultLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(vaultParams, request.params, reply);
    if (!p.ok) return;
    const { shopId } = p.data;
    // one budget unit covers the view and the creation tx lookup of an uncached id
    if (!viewCache.has(shopId) && !chainBudget.take()) return busy(reply);
    let read;
    try {
      read = await viewCache.get(shopId, () => readVault(vaultChain, shopId, VAULT_CODE_HASH));
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
    if (read.kind === 'missing') return quietError(reply, 404, 'NOT_FOUND', 'Account not found', null, { shopId });
    if (read.kind === 'foreign')
      return quietError(reply, 422, 'NOT_A_VAULT', 'Not a Secret Shopper vault: the account runs other code or was never initialized', { codeHash: read.codeHash }, { shopId });
    const vault = read.vault;
    const createdTx = await createdCache.get(shopId, () => createdTxOf(shopId));
    let registered: boolean | null = null;
    try {
      registered = !!(await prismaQuery.company.findUnique({ where: { shopContractId: shopId }, select: { id: true } }));
    } catch (error) {
      // the chain view stands on its own; `registered: null` tells the client the lookup failed
      request.log.warn({ err: error, shopId }, 'company lookup failed');
    }
    return reply.code(200).send({ success: true, error: null, data: { ...vault, createdTx, registered } });
  });

  done();
};
