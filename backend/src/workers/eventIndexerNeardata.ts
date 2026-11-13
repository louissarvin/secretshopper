import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { NEAR } from '../lib/near/client.ts';
import { parseOutcomeEvents, type ContractEventRow } from '../lib/near/events.ts';
import { EVENT_STANDARD, INDEXER_BATCH_BLOCKS, INDEXER_INTERVAL, SHOP_CONTRACT_ID } from '../config/main-config.ts';
import { startHeight } from './nearEventIndexer.ts';
import { createLogger, errFields } from '../utils/logger.ts';

// Fallback when the FastNEAR Transactions API is down: one neardata request per block.
const log = createLogger('indexer-neardata');
const CURSOR_ID = `neardata:${SHOP_CONTRACT_ID}`;

interface NeardataOutcome {
  tx_hash: string | null;
  execution_outcome: { id: string; outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } };
}
type Block = { block: { header: { height: number; timestamp_nanosec?: string; timestamp?: number } }; shards: { receipt_execution_outcomes: NeardataOutcome[] }[] } | null;

let isRunning = false;

const getJson = async <T>(path: string): Promise<T> => {
  // /v0/last_block/final redirects to /v0/block/{h}; fetch follows it
  const res = await fetch(`${NEAR.neardataUrl}${path}`, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`neardata ${path} ${res.status}`);
  return (await res.json()) as T;
};

const indexBlocks = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    const from = await startHeight(CURSOR_ID);
    if (from === null) {
      log.warn('no start height: register the company or set INDEXER_START_HEIGHT');
      return;
    }
    const head = (await getJson<NonNullable<Block>>('/v0/last_block/final')).block.header.height;
    const target = Math.min(head, from + INDEXER_BATCH_BLOCKS);
    for (let h = from + 1; h <= target; h++) {
      const block = await getJson<Block>(`/v0/block/${h}`); // null = skipped height
      const rows: ContractEventRow[] = [];
      const header = block?.block.header;
      const tsNs = header?.timestamp_nanosec ?? String(header?.timestamp ?? 0);
      for (const shard of block?.shards ?? []) {
        for (const o of shard.receipt_execution_outcomes) {
          const eo = o.execution_outcome;
          rows.push(
            ...parseOutcomeEvents(
              { id: eo.id, executorId: eo.outcome.executor_id, logs: eo.outcome.logs, status: eo.outcome.status, blockHeight: h, blockTimestampNs: tsNs, txHash: o.tx_hash ?? '' },
              SHOP_CONTRACT_ID,
              EVENT_STANDARD
            )
          );
        }
      }
      await prismaQuery.$transaction([
        prismaQuery.contractEvent.createMany({ data: rows, skipDuplicates: true }),
        prismaQuery.chainCursor.upsert({
          where: { id: CURSOR_ID },
          create: { id: CURSOR_ID, blockHeight: BigInt(h) },
          update: { blockHeight: BigInt(h) },
        }),
      ]);
      if (rows.length > 0) log.info('indexed events', { count: rows.length, height: h });
    }
  } catch (error) {
    log.error('run failed', errFields(error));
  } finally {
    isRunning = false;
  }
};

export const startEventIndexerNeardata = (): cron.ScheduledTask => {
  // default vault only: a multi-vault block scan needs a shared cursor and a contract filter
  log.warn('neardata fallback indexes the default vault only; other registered vaults are not indexed in this mode', { shop: SHOP_CONTRACT_ID });
  log.info('scheduled', { interval: INDEXER_INTERVAL, source: 'neardata', contract: SHOP_CONTRACT_ID });
  const task = cron.schedule(INDEXER_INTERVAL, indexBlocks);
  void indexBlocks();
  return task;
};
