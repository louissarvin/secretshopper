import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { getAllTests, getBatches, getPolicy, getTests } from '../lib/near/shop.ts';
import { buildReputation, type Reputation } from '../lib/reputation.ts';
import { reputationReads } from '../lib/near/reputationReads.ts';
import { createLru } from '../utils/lruCache.ts';
import { createBudget } from '../lib/intents/quote.ts';
import { computeThroughput, windowFromSlots, type InvoiceDecision } from '../lib/throughput.ts';
import { loadModelRuns, type ModelRuns } from '../lib/modelRunsFiles.ts';
import { readChainSchedule, withClock } from '../lib/schedule.ts';
import { B1_SUMMARY_PATH, MODEL_RUNS_DIR, RELEASE_TICK_MINUTES, VAULT_CODE_HASH, VERIFY_REPORT_PATH } from '../config/main-config.ts';
import { readFile, stat } from 'node:fs/promises';
import { parseVerifyReport, type VerifyReport } from '../lib/verifyReport.ts';
import { handleNotFoundError, handleServerError, handleUpstreamError } from '../utils/errorHandler.ts';
import { accountIdSchema, parseOr400 } from '../utils/validation.ts';
import { cached } from '../utils/ttlCache.ts';
import { createLogger, errFields } from '../utils/logger.ts';

// Public read-outs for the web: committed measurements, a vault's schedule and throughput, and vendor reputation.

const log = createLogger('insight-routes');
const limit30 = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const SCHEDULE_TTL_MS = 30_000;
const shopParams = z.object({ shopId: accountIdSchema }).strict();

// Committed files change only with a deploy, so one successful read serves the process.
let modelRuns: Promise<ModelRuns> | null = null;
const modelRunsOnce = () => {
  modelRuns ??= loadModelRuns(MODEL_RUNS_DIR, B1_SUMMARY_PATH).then((r) => {
    if (!r.runs.length) throw new Error(`no pass-rate runs in ${MODEL_RUNS_DIR}`);
    return r;
  });
  modelRuns.catch(() => (modelRuns = null));
  return modelRuns;
};

// `bun run verify` may rewrite the file while the API runs, so it is re-read after a minute.
const VERIFY_TTL_MS = 60_000;
const MAX_VERIFY_REPORT_BYTES = 256 * 1024;
const loadVerifyReport = async (path: string): Promise<VerifyReport> => {
  if ((await stat(path)).size > MAX_VERIFY_REPORT_BYTES) throw new Error(`${path} is over ${MAX_VERIFY_REPORT_BYTES} bytes`);
  return parseVerifyReport(JSON.parse(await readFile(path, 'utf8')));
};
const unavailable = (reply: FastifyReply, code: string, message: string) =>
  reply.code(503).send({ success: false, error: { code, message }, data: null, timestamp: new Date().toISOString() });

// shorter than delivery.ts TICK_LEAD_MS (60 s): a batch committed after this read cannot have a lure delivered yet
const THROUGHPUT_TTL_MS = 10_000;

/** Real invoices before the cutoff with their indexed decisions on this vault; revealed lures are dropped by id in SQL too. */
const invoiceDecisions = (companyId: string, shopId: string, before: Date, excluded: string[]) =>
  prismaQuery.$queryRaw<{ invoiceId: string; deliverAt: Date; autoPaid: boolean; ownerPaid: boolean; proposed: boolean; declined: boolean }[]>`
    SELECT i."invoiceId", i."deliverAt",
      COALESCE(bool_or(e.event = 'paid' AND e.data->>'by_owner' IS DISTINCT FROM 'true'), false) AS "autoPaid",
      COALESCE(bool_or(e.event = 'paid' AND e.data->>'by_owner' = 'true'), false) AS "ownerPaid",
      COALESCE(bool_or(e.event = 'proposed'), false) AS "proposed",
      COALESCE(bool_or(e.event = 'declined'), false) AS "declined"
    FROM "public"."invoices" i
    LEFT JOIN "public"."ContractEvent" e
      ON e."contractId" = ${shopId} AND e.event IN ('paid', 'proposed', 'declined') AND e.data->>'invoice_id' = i."invoiceId"
    WHERE i."companyId" = ${companyId} AND i."deliverAt" < ${before} AND NOT (i."invoiceId" = ANY(${excluded}::text[]))
    GROUP BY i."invoiceId", i."deliverAt"`;

// Vendor ids are attacker-chosen: a route-owned LRU, and a global budget for uncached scans (each is up to ~30 tx API
// calls plus three views per vault, at most 50 vaults).
const REPUTATION_TTL_MS = 5 * 60_000;
const reputationCache = createLru<Reputation>(128, REPUTATION_TTL_MS);
const reputationBudget = createBudget(20, 60_000);
const vendorParams = z.object({ vendorId: accountIdSchema }).strict();

const companyFor = (shopId: string) => prismaQuery.company.findUnique({ where: { shopContractId: shopId }, select: { id: true } });

export const insightRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/model-runs', { config: limit30 }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.code(200).send({ success: true, error: null, data: await modelRunsOnce() });
    } catch (error) {
      log.error('model runs unavailable', { dir: MODEL_RUNS_DIR, ...errFields(error) });
      return unavailable(reply, 'MODEL_RUNS_UNAVAILABLE', 'Model runs are not available');
    }
  });

  app.get('/verify-report', { config: limit30 }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.code(200).send({ success: true, error: null, data: await cached(`verify-report:${VERIFY_REPORT_PATH}`, VERIFY_TTL_MS, () => loadVerifyReport(VERIFY_REPORT_PATH)) });
    } catch (error) {
      log.error('verify report unavailable', { path: VERIFY_REPORT_PATH, ...errFields(error) });
      return unavailable(reply, 'VERIFY_REPORT_UNAVAILABLE', 'The verify report is not available');
    }
  });

  // Every vault this vendor armed, from chain only (lib/reputation.ts).
  app.get('/agent/:vendorId', { config: limit30 }, async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(vendorParams, request.params, reply);
    if (!p.ok) return;
    const { vendorId } = p.data;
    if (!reputationCache.has(vendorId) && !reputationBudget.take()) return unavailable(reply, 'REPUTATION_BUSY', 'Too many reputation lookups right now, retry in a minute');
    try {
      return reply.code(200).send({ success: true, error: null, data: await reputationCache.get(vendorId, () => buildReputation(vendorId, VAULT_CODE_HASH, reputationReads)) });
    } catch (error) {
      return handleUpstreamError(reply, 'Chain lookup', error as Error);
    }
  });

  // Two-sided scorecard: real invoices only, and only those no sealed lure could be among (lib/throughput.ts).
  app.get('/throughput/:shopId', { config: limit30 }, async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(shopParams, request.params, reply);
    if (!p.ok) return;
    const { shopId } = p.data;
    let company;
    try {
      company = await companyFor(shopId);
      if (!company) return handleNotFoundError(reply, 'Shop');
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
    let slots;
    try {
      slots = await cached(`throughput-slots:${shopId}`, THROUGHPUT_TTL_MS, () => getAllTests(shopId));
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
    try {
      const w = windowFromSlots(slots, Date.now());
      const rows: InvoiceDecision[] = await invoiceDecisions(company.id, shopId, w.asOf, [...w.revealedInvoiceIds]);
      return reply.code(200).send({ success: true, error: null, data: { shopId, ...computeThroughput(rows, w), source: 'invoices + indexed paid, proposed and declined events; slots from get_tests' } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  // Registered shops only, so this is not an open RPC proxy. Batch-level timing only: never which inbox item is a test.
  app.get('/schedule/:shopId', { config: limit30 }, async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await parseOr400(shopParams, request.params, reply);
    if (!p.ok) return;
    const { shopId } = p.data;
    try {
      if (!(await companyFor(shopId))) return handleNotFoundError(reply, 'Shop');
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
    try {
      const chain = await cached(`schedule:${shopId}`, SCHEDULE_TTL_MS, () =>
        readChainSchedule({
          batches: (from, n) => getBatches(shopId, from, n),
          tests: (from, n) => getTests(shopId, from, n),
          batchIntervalNs: async () => (await getPolicy(shopId)).batch_interval,
        })
      );
      return reply.code(200).send({ success: true, error: null, data: withClock(chain, Date.now(), RELEASE_TICK_MINUTES) });
    } catch (error) {
      return handleUpstreamError(reply, 'NEAR RPC', error as Error);
    }
  });

  done();
};
