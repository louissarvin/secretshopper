import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { getFinalBlockHeight } from '../lib/near/client.ts';
import { fetchTransactions, listContractTxHashes, parseTxEvents } from '../lib/near/events.ts';
import { backgroundRpc, backgroundTxApi } from '../lib/near/background.ts';
import { isRateLimited, RateLimitedError } from '../lib/near/rateLimit.ts';
import { registry } from '../lib/registry.ts';
import { afterVisit, emptyState, isIdle, pickDue, type SchedVault, type VaultSchedState } from '../lib/indexerSchedule.ts';
import {
  EVENT_STANDARD,
  INDEXER_FINALITY_LAG,
  INDEXER_INTERVAL,
  INDEXER_MAX_SPAN,
  INDEXER_OTHER_EVERY_TICKS,
  INDEXER_SPANS_PER_TICK,
  INDEXER_SPANS_PER_TICK_OTHER,
  INDEXER_START_HEIGHT,
  INDEXER_VAULTS_PER_TICK,
  SHOP_CONTRACT_ID,
} from '../config/main-config.ts';
import { createLogger, errFields } from '../utils/logger.ts';

const log = createLogger('indexer');
const cursorOf = (shop: string) => `events:${shop}`; // shop4's existing cursor row is reused untouched

let isRunning = false;
let tick = 0;
let rr = 0; // round-robin position over the non-default vaults
const states = new Map<string, VaultSchedState>();
const LAST_EVENT_TTL_MS = 5 * 60_000;
const lastEvents = new Map<string, { at: number; value: number | null }>();

/** Start height: cursor, else the company's deploy block, else INDEXER_START_HEIGHT (default vault only). */
export const startHeight = async (cursorId: string, shop: string = SHOP_CONTRACT_ID): Promise<number | null> => {
  const cursor = await prismaQuery.chainCursor.findUnique({ where: { id: cursorId } });
  if (cursor) return Number(cursor.blockHeight);
  const company = await prismaQuery.company.findUnique({ where: { shopContractId: shop }, select: { deployBlock: true } });
  if (company && company.deployBlock > 0n) return Number(company.deployBlock);
  return shop === SHOP_CONTRACT_ID && INDEXER_START_HEIGHT > 0 ? INDEXER_START_HEIGHT : null;
};

// Block time of the newest indexed event (database only), to tell idle vaults apart.
const lastEventAt = async (shop: string): Promise<number | null> => {
  const hit = lastEvents.get(shop);
  if (hit && Date.now() - hit.at < LAST_EVENT_TTL_MS) return hit.value;
  const row = await prismaQuery.contractEvent.findFirst({ where: { contractId: shop }, orderBy: { blockHeight: 'desc' }, select: { blockTime: true } });
  const value = row?.blockTime.getTime() ?? null;
  lastEvents.set(shop, { at: Date.now(), value });
  return value;
};

/** Up to `maxSpans` spans of one vault towards `safeHead`. Tx API calls make one attempt: a 429 backs the vault off. */
const indexVault = async (shop: string, maxSpans: number, safeHead: number): Promise<void> => {
  const cursorId = cursorOf(shop);
  for (let span = 0; span < maxSpans; span++) {
    const from = await startHeight(cursorId, shop);
    if (from === null) {
      log.warn('no start height: register the company or set INDEXER_START_HEIGHT', { shop });
      return;
    }
    if (safeHead <= from) return;
    const to = Math.min(safeHead, from + INDEXER_MAX_SPAN);

    const hashes = await backgroundTxApi.run(() => listContractTxHashes(shop, from, to, 1));
    const txs = hashes.length ? await backgroundTxApi.run(() => fetchTransactions(hashes, 1)) : [];
    const rows = txs.flatMap((tx) => parseTxEvents(tx, shop, EVENT_STANDARD));

    // Events and cursor move together; the unique (receiptId, logIndex) makes reruns harmless.
    await prismaQuery.$transaction([
      prismaQuery.contractEvent.createMany({ data: rows, skipDuplicates: true }),
      prismaQuery.chainCursor.upsert({ where: { id: cursorId }, create: { id: cursorId, blockHeight: BigInt(to) }, update: { blockHeight: BigInt(to) } }),
    ]);
    if (rows.length > 0) {
      log.info('indexed events', { shop, count: rows.length, from, to });
      lastEvents.delete(shop);
    }
    if (to === safeHead) return;
  }
  log.info('still catching up, continuing next visit', { shop, spans: maxSpans });
};

const failed = (shop: string, now: number, error: unknown) => {
  const rateLimited = isRateLimited(error);
  const next = afterVisit(states.get(shop) ?? emptyState(), now, { ok: false, rateLimited, retryAfterMs: error instanceof RateLimitedError ? error.retryAfterMs : null });
  states.set(shop, next);
  if (rateLimited) log.warn('rate limited, backing off', { shop, failures: next.failures, retryInS: Math.round((next.nextAt - now) / 1000) });
  else log.error('run failed', { shop, ...errFields(error) });
};

// The default vault every tick (unless backing off); other vaults every INDEXER_OTHER_EVERY_TICKS ticks, idle ones hourly.
const indexEvents = async (): Promise<void> => {
  if (isRunning) {
    log.debug('previous run still active, skipping');
    return;
  }
  isRunning = true;
  tick++;
  try {
    const now = Date.now();
    const listed = await registry.list();
    const vaults: SchedVault[] = [];
    if (!listed.some((v) => v.isDefault)) vaults.push({ shop: SHOP_CONTRACT_ID, isDefault: true, testerEnabled: true, lastEventAtMs: null });
    for (const v of listed) vaults.push({ shop: v.shop, isDefault: v.isDefault, testerEnabled: v.isDefault || v.testerEnabled, lastEventAtMs: null });
    // idle detection reads the database only on ticks that may visit other vaults
    if (tick % INDEXER_OTHER_EVERY_TICKS === 0) for (const v of vaults) if (!v.isDefault) v.lastEventAtMs = await lastEventAt(v.shop);
    const pick = pickDue(vaults, states, tick, now, { otherEveryTicks: INDEXER_OTHER_EVERY_TICKS, maxOthers: INDEXER_VAULTS_PER_TICK, rr });
    rr = pick.rr;
    if (!pick.due.length) return;

    // one head read per tick for every vault visited, through the background budget
    let safeHead: number;
    try {
      safeHead = (await backgroundRpc.run(() => getFinalBlockHeight())) - INDEXER_FINALITY_LAG;
    } catch (error) {
      for (const v of pick.due) failed(v.shop, now, error);
      return;
    }
    for (const v of pick.due) {
      try {
        await indexVault(v.shop, v.isDefault ? INDEXER_SPANS_PER_TICK : INDEXER_SPANS_PER_TICK_OTHER, safeHead);
        states.set(v.shop, afterVisit(states.get(v.shop) ?? emptyState(), Date.now(), { ok: true }));
      } catch (error) {
        failed(v.shop, Date.now(), error);
        // a rate limit is shared by every vault: stop this tick rather than spend more calls on a 429
        if (isRateLimited(error)) break;
      }
    }
    if (pick.due.some((v) => !v.isDefault)) log.debug('visited', { shops: pick.due.map((v) => v.shop), idle: pick.due.filter((v) => isIdle(v, now)).map((v) => v.shop) });
  } catch (error) {
    log.error('vault list failed', errFields(error));
  } finally {
    isRunning = false;
  }
};

export const startNearEventIndexer = (): cron.ScheduledTask => {
  log.info('scheduled', { interval: INDEXER_INTERVAL, source: 'fastnear', contract: SHOP_CONTRACT_ID, otherVaultsPerVisit: INDEXER_VAULTS_PER_TICK, otherEveryTicks: INDEXER_OTHER_EVERY_TICKS });
  const task = cron.schedule(INDEXER_INTERVAL, indexEvents);
  void indexEvents();
  return task;
};
