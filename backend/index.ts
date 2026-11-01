import './dotenv.ts';

import type cron from 'node-cron';
import { APP_PORT, APP_HOST, INDEXER_SOURCE, NEAR, SHOP_CONTRACT_ID } from './src/config/main-config.ts';
import { buildApp } from './src/app.ts';
import { prismaQuery } from './src/lib/prisma.ts';
import { createLogger, errFields } from './src/utils/logger.ts';
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { startNearEventIndexer } from './src/workers/nearEventIndexer.ts';
import { startEventIndexerNeardata } from './src/workers/eventIndexerNeardata.ts';
import { startShopProjectorWorker } from './src/workers/shopProjector.ts';
import { startAlertWorker } from './src/workers/alertWorker.ts';

const log = createLogger('api');

const start = async (): Promise<void> => {
  const app = await buildApp();
  const tasks: cron.ScheduledTask[] = [];
  let alerts: ReturnType<typeof startAlertWorker> | null = null;
  try {
    tasks.push(startErrorLogCleanupWorker());
    tasks.push(INDEXER_SOURCE === 'neardata' ? startEventIndexerNeardata() : startNearEventIndexer());
    tasks.push(startShopProjectorWorker());
    alerts = startAlertWorker();

    await app.listen({ port: APP_PORT, host: APP_HOST });
    log.info('started', { port: APP_PORT, network: NEAR.network, shop: SHOP_CONTRACT_ID, indexer: INDEXER_SOURCE });
  } catch (error) {
    log.error('failed to start', errFields(error));
    process.exit(1);
  }

  // Finish in-flight requests, stop cron, release the pool.
  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutting down', { signal });
    tasks.forEach((t) => t.stop());
    alerts?.stop();
    try {
      await app.close();
      await prismaQuery.$disconnect();
    } catch (error) {
      log.error('shutdown error', errFields(error));
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
};

void start();
