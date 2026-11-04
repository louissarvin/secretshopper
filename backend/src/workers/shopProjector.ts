import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { applyEvent } from '../lib/near/applyEvent.ts';
import { registry } from '../lib/registry.ts';
import { PROJECTOR_INTERVAL } from '../config/main-config.ts';
import { createLogger, errFields } from '../utils/logger.ts';

const log = createLogger('projector');
const BATCH = 500;

let isRunning = false;

/** One vault: unprojected rows in chain order; rows that depend on a later-indexed event stay for the next tick. */
export const projectVault = async (companyId: string, shop: string): Promise<number> => {
  const events = await prismaQuery.contractEvent.findMany({
    where: { contractId: shop, projectedAt: null },
    orderBy: [{ blockHeight: 'asc' }, { receiptId: 'asc' }, { logIndex: 'asc' }],
    take: BATCH, // per vault, so rows stuck in one vault cannot starve another
  });
  let applied = 0;
  for (const ev of events) {
    try {
      if (await applyEvent(companyId, shop, ev)) {
        await prismaQuery.contractEvent.update({ where: { id: ev.id }, data: { projectedAt: new Date() } });
        applied++;
      }
    } catch (error) {
      log.error('apply failed', { shop, eventId: ev.id, event: ev.event, receiptId: ev.receiptId, ...errFields(error) });
    }
  }
  if (applied > 0) log.info('projected events', { shop, applied, pending: events.length - applied });
  return applied;
};

const project = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    for (const v of await registry.list()) {
      try {
        await projectVault(v.companyId, v.shop);
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

export const startShopProjectorWorker = (): cron.ScheduledTask => {
  log.info('scheduled', { interval: PROJECTOR_INTERVAL });
  const task = cron.schedule(PROJECTOR_INTERVAL, project);
  void project();
  return task;
};
