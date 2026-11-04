import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { getFinalBlockHeight } from '../lib/near/client.ts';
import { fetchTransactions, listContractTxHashes, parseTxEvents } from '../lib/near/events.ts';
import { registry } from '../lib/registry.ts';
import { pickRoundRobin } from '../lib/vaults.ts';
import {
  EVENT_STANDARD,
  INDEXER_FINALITY_LAG,
  INDEXER_INTERVAL,
  INDEXER_MAX_SPAN,
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
let nextOther = 0; // round-robin position over the non-default vaults

/** Start height: cursor, else the company's deploy block, else INDEXER_START_HEIGHT (default vault only). */
export const startHeight = async (cursorId: string, shop: string = SHOP_CONTRACT_ID): Promise<number | null> => {
  const cursor = await prismaQuery.chainCursor.findUnique({ where: { id: cursorId } });
  if (cursor) return Number(cursor.blockHeight);
  const company = await prismaQuery.company.findUnique({ where: { shopContractId: shop }, select: { deployBlock: true } });
  if (company && company.deployBlock > 0n) return Number(company.deployBlock);
  return shop === SHOP_CONTRACT_ID && INDEXER_START_HEIGHT > 0 ? INDEXER_START_HEIGHT : null;
};

/** Indexes up to `maxSpans` spans of one vault; true when it reached the safe head. */
const indexVault = async (shop: string, maxSpans: number): Promise<boolean> => {
  const cursorId = cursorOf(shop);
  // catch up in one tick after downtime: consecutive spans until the safe head (bounded per tick)
  for (let span = 0; span < maxSpans; span++) {
    const from = await startHeight(cursorId, shop);
    if (from === null) {
      log.warn('no start height: register the company or set INDEXER_START_HEIGHT', { shop });
      return true;
    }
    // Lag so every receipt of a listed tx has executed (the account index lists txs early).
    const safeHead = (await getFinalBlockHeight()) - INDEXER_FINALITY_LAG;
    if (safeHead <= from) return true;
    const to = Math.min(safeHead, from + INDEXER_MAX_SPAN);

    const hashes = await listContractTxHashes(shop, from, to);
    const txs = await fetchTransactions(hashes);
    const rows = txs.flatMap((tx) => parseTxEvents(tx, shop, EVENT_STANDARD));

    // Events and cursor move together; the unique (receiptId, logIndex) makes reruns harmless.
    await prismaQuery.$transaction([
      prismaQuery.contractEvent.createMany({ data: rows, skipDuplicates: true }),
      prismaQuery.chainCursor.upsert({ where: { id: cursorId }, create: { id: cursorId, blockHeight: BigInt(to) }, update: { blockHeight: BigInt(to) } }),
    ]);
    if (rows.length > 0) log.info('indexed events', { shop, count: rows.length, from, to });
    if (to === safeHead) return true;
  }
  return false;
};

// The default vault every tick as before, then a few other vaults round robin; one failing vault never stops another.
const indexEvents = async (): Promise<void> => {
  if (isRunning) {
    log.debug('previous run still active, skipping');
    return;
  }
  isRunning = true;
  try {
    try {
      if (!(await indexVault(SHOP_CONTRACT_ID, INDEXER_SPANS_PER_TICK))) log.info('still catching up, continuing next tick', { shop: SHOP_CONTRACT_ID, spans: INDEXER_SPANS_PER_TICK });
    } catch (error) {
      log.error('run failed', { shop: SHOP_CONTRACT_ID, ...errFields(error) });
    }
    const others = (await registry.list()).filter((v) => !v.isDefault);
    const { picked, next } = pickRoundRobin(others, nextOther, INDEXER_VAULTS_PER_TICK);
    nextOther = next;
    for (const v of picked) {
      try {
        await indexVault(v.shop, INDEXER_SPANS_PER_TICK_OTHER);
      } catch (error) {
        log.error('run failed', { shop: v.shop, ...errFields(error) });
      }
    }
  } catch (error) {
    log.error('vault list failed', errFields(error));
  } finally {
    isRunning = false;
  }
};

export const startNearEventIndexer = (): cron.ScheduledTask => {
  log.info('scheduled', { interval: INDEXER_INTERVAL, source: 'fastnear', contract: SHOP_CONTRACT_ID, otherVaultsPerTick: INDEXER_VAULTS_PER_TICK });
  const task = cron.schedule(INDEXER_INTERVAL, indexEvents);
  void indexEvents();
  return task;
};
