import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { ERROR_LOG_MAX_RECORDS, ERROR_LOG_CLEANUP_INTERVAL } from '../config/main-config.ts';
import { createLogger, errFields } from '../utils/logger.ts';

const log = createLogger('error-log-cleanup');
const CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;

let isRunning = false;

// Caps ErrorLog and drops auth challenges a day after expiry (both are operational data, not user data).
const cleanup = async (): Promise<void> => {
  if (isRunning) {
    log.debug('previous cleanup still running, skipping');
    return;
  }
  isRunning = true;
  try {
    const count = await prismaQuery.errorLog.count();
    if (count > ERROR_LOG_MAX_RECORDS) {
      const oldest = await prismaQuery.errorLog.findMany({
        orderBy: { createdAt: 'asc' },
        take: count - ERROR_LOG_MAX_RECORDS,
        select: { id: true },
      });
      await prismaQuery.errorLog.deleteMany({ where: { id: { in: oldest.map((r) => r.id) } } });
      log.info('trimmed error logs', { deleted: oldest.length, kept: ERROR_LOG_MAX_RECORDS });
    }
    const expired = await prismaQuery.authChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - CHALLENGE_RETENTION_MS) } },
    });
    if (expired.count > 0) log.info('removed expired auth challenges', { deleted: expired.count });
  } catch (error) {
    log.error('cleanup failed', errFields(error));
  } finally {
    isRunning = false;
  }
};

export const startErrorLogCleanupWorker = (): cron.ScheduledTask => {
  log.info('scheduled', { interval: ERROR_LOG_CLEANUP_INTERVAL });
  const task = cron.schedule(ERROR_LOG_CLEANUP_INTERVAL, cleanup);
  void cleanup();
  return task;
};
