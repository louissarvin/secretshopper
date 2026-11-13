import { NEAR } from '../lib/near/client.ts';
import { alertBody, type Alert } from '../lib/alerts/map.ts';
import { alertToken } from '../lib/alerts/token.ts';
import { deliver } from '../lib/alerts/webhook.ts';
import { createEventRunner, createHealthRunner } from '../lib/alerts/runner.ts';
import { eventStore, healthStore } from '../lib/alerts/stores.ts';
import { readHealth } from '../lib/alerts/healthReads.ts';
import { registry } from '../lib/registry.ts';
import { backgroundRpc } from '../lib/near/background.ts';
import { chainNowMs } from '../lib/near/client.ts';
import { mapLimit } from '../utils/concurrency.ts';
import {
  ALERT_HEALTH_OTHER_EVERY_RUNS,
  ALERT_HEALTH_SECONDS,
  ALERT_POLL_SECONDS,
  ALERT_TIMEOUT_MS,
  ALERT_WEBHOOK_SECRET,
  ALERT_WEBHOOK_URLS,
  RELEASE_TICK_MINUTES,
  SHOP_CONTRACT_ID,
} from '../config/main-config.ts';
import { createLogger, errFields } from '../utils/logger.ts';

const log = createLogger('alerts');

const send = async (alert: Alert): Promise<void> => {
  const body = alertBody(alert);
  const results = await Promise.all(
    ALERT_WEBHOOK_URLS.map(async (url) => ({ host: new URL(url).host, r: await deliver(url, body, { timeoutMs: ALERT_TIMEOUT_MS, secret: ALERT_WEBHOOK_SECRET || undefined }) }))
  );
  for (const { host, r } of results) {
    // host only: the path of a Slack or Discord webhook URL is its secret
    if (r.ok) log.info('alert sent', { alertId: alert.id, type: alert.type, host, attempts: r.attempts });
    else log.error('alert delivery failed', { alertId: alert.id, type: alert.type, host, attempts: r.attempts, status: r.status, error: r.error });
  }
};

const ctx = { vault: SHOP_CONTRACT_ID, network: NEAR.network };
const HEALTH_CONCURRENCY = 1; // reads already wait on the background budget; one vault at a time keeps bursts small

/** Runs `f` every `seconds`, skipping a run while the previous one is still going. */
const every = (name: string, seconds: number, f: () => Promise<unknown>): (() => void) => {
  let isRunning = false;
  const run = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await f();
    } catch (error) {
      log.error('run failed', { worker: name, ...errFields(error) });
    } finally {
      isRunning = false;
    }
  };
  const handle = setInterval(() => void run(), seconds * 1000);
  void run();
  return () => clearInterval(handle);
};

/**
 * Event alerts (only with ALERT_WEBHOOK_URLS) and health checks (always: /company/alerts lists their state).
 * Both read the chain and the indexed events; neither touches the indexer.
 */
export const startAlertWorker = (): { stop: () => void } => {
  const hooks = ALERT_WEBHOOK_URLS.length > 0;
  const stops: (() => void)[] = [];
  if (hooks) {
    const events = createEventRunner({
      store: eventStore(SHOP_CONTRACT_ID),
      context: async (rows) => ({ ...ctx, token: rows.some((r) => r.event === 'proposed') ? await alertToken(SHOP_CONTRACT_ID) : undefined }),
      send,
    });
    stops.push(every('events', ALERT_POLL_SECONDS, events.tick));
  }
  // Health per registered vault (the default even before it is registered). Webhooks belong to the operator, so only
  // the default vault's conditions are sent; every vault's state shows in its own /company/alerts.
  const runners = new Map<string, ReturnType<typeof createHealthRunner>>();
  const runnerFor = (shop: string) => {
    let r = runners.get(shop);
    if (!r) {
      const vctx = { vault: shop, network: NEAR.network };
      r = createHealthRunner({ store: healthStore(shop), context: () => vctx, send: hooks && shop === SHOP_CONTRACT_ID ? send : null });
      runners.set(shop, r);
    }
    return r;
  };
  let healthRun = 0;
  stops.push(
    every('health', ALERT_HEALTH_SECONDS, async () => {
      healthRun++;
      const listed = await registry.list();
      const all = listed.some((v) => v.isDefault) ? listed : [{ shop: SHOP_CONTRACT_ID, isDefault: true, testerEnabled: false }, ...listed];
      // the default vault and tested vaults every run; the rest every ALERT_HEALTH_OTHER_EVERY_RUNS runs
      const vaults = all.filter((v) => v.isDefault || v.testerEnabled || healthRun % ALERT_HEALTH_OTHER_EVERY_RUNS === 1 || ALERT_HEALTH_OTHER_EVERY_RUNS === 1);
      let now: number | undefined;
      try {
        now = await backgroundRpc.run(() => chainNowMs());
      } catch (error) {
        log.warn('chain time unreadable; each vault reads its own', errFields(error));
      }
      await mapLimit(vaults, HEALTH_CONCURRENCY, async (v) => {
        try {
          // the default vault is tested from env whatever its row says
          const opts = { chainNowMs: now, run: backgroundRpc.run };
          const fired = await runnerFor(v.shop).apply(await readHealth(v.shop, RELEASE_TICK_MINUTES, v.isDefault ? opts : { ...opts, testerEnabled: v.testerEnabled }));
          if (fired.length) log.warn('health alert', { shop: v.shop, kinds: fired });
        } catch (error) {
          log.error('health run failed', { shop: v.shop, ...errFields(error) });
        }
      });
    })
  );
  log.info('started', { webhooks: ALERT_WEBHOOK_URLS.length, eventIntervalS: ALERT_POLL_SECONDS, healthIntervalS: ALERT_HEALTH_SECONDS });
  return { stop: () => stops.forEach((s) => s()) };
};
