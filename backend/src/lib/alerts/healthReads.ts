import { prismaQuery } from '../prisma.ts';
import { chainNowMs, rpc } from '../near/client.ts';
import { getPolicy, getScorecard, getStatus, nsToDate } from '../near/shop.ts';
import { releaseAtNs } from '../releases.ts';
import { createLogger, errFields } from '../../utils/logger.ts';
import { commitStalled, overfundedMicroNear, releaseStallAgeMs, releaseStalled, stallBits } from './health.ts';
import type { HealthKind } from './map.ts';

const log = createLogger('alerts:health');

const atLeast23 = (version: string): boolean => {
  const [a, b] = version.split('.').map(Number);
  return a > 2 || (a === 2 && b >= 3);
};

// A failed read leaves its condition unknown (undefined), so an RPC outage neither clears nor raises it.
const tryRead = async <T>(what: string, f: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await f();
  } catch (error) {
    log.warn('health read failed', { what, ...errFields(error) });
    return undefined;
  }
};

/** The newest delivered tick old enough to need a release, and whether its release_posted is indexed. */
const releaseCheck = async (shop: string, tickMinutes: number, nowMs: number) => {
  const company = await prismaQuery.company.findUnique({ where: { shopContractId: shop }, select: { id: true } });
  if (!company) return false;
  const tick = await prismaQuery.invoice.findFirst({
    where: { companyId: company.id, deliverAt: { lte: new Date(nowMs - releaseStallAgeMs(tickMinutes)) } },
    orderBy: { deliverAt: 'desc' },
    select: { deliverAt: true },
  });
  if (!tick) return false;
  const posted = await prismaQuery.contractEvent.findFirst({
    where: { contractId: shop, event: 'release_posted', data: { path: ['release_at'], equals: releaseAtNs(tick.deliverAt) } },
    select: { id: true },
  });
  return releaseStalled({ tickMs: tick.deliverAt.getTime(), posted: !!posted, nowMs, tickMinutes });
};

const gasKeyBalances = async (shop: string): Promise<bigint[]> => {
  const { keys } = await rpc.viewAccessKeyList({ accountId: shop, finalityQuery: { finality: 'final' } });
  return keys.flatMap((k) => {
    const g = (k.access_key.permission as { GasKeyFunctionCall?: { balance?: unknown } }).GasKeyFunctionCall;
    return g && typeof g.balance === 'string' && /^\d{1,40}$/.test(g.balance) ? [BigInt(g.balance)] : [];
  });
};

/**
 * Current reading of each health condition for `shop`; undefined where a read failed. `testerEnabled: false` reads
 * tester_stalled as clear: a self-serve vault that never enabled testing has no tester to stall (v2/37 section 7).
 */
export const readHealth = async (shop: string, tickMinutes: number, o: { testerEnabled?: boolean } = {}): Promise<Partial<Record<HealthKind, bigint>>> => {
  const [scorecard, status, policy, chainNow] = await Promise.all([
    tryRead('scorecard', () => getScorecard(shop)),
    tryRead('status', () => getStatus(shop)),
    tryRead('policy', () => getPolicy(shop)),
    tryRead('chain time', () => chainNowMs()),
  ]);
  const out: Partial<Record<HealthKind, bigint>> = {};
  if (scorecard) out.reveal_overdue = BigInt(scorecard.overdue_unrevealed);

  if (o.testerEnabled === false) out.tester_stalled = 0n;
  else if (status && policy && chainNow !== undefined) {
    // release ticks are labelled by the API host clock, the batch cadence by chain time
    const release = atLeast23(status.version) ? await tryRead('releases', () => releaseCheck(shop, tickMinutes, Date.now())) : false;
    const lastBatch = await tryRead('last batch', () =>
      prismaQuery.contractEvent.findFirst({ where: { contractId: shop, event: 'batch_committed' }, orderBy: { blockHeight: 'desc' }, select: { blockTime: true } })
    );
    const commit =
      lastBatch === undefined
        ? undefined
        : commitStalled({
            armed: status.mode === 'Armed',
            lastBatchMs: lastBatch?.blockTime.getTime() ?? null,
            armedAtMs: nsToDate(status.armed_at).getTime(),
            intervalMs: Number(BigInt(policy.batch_interval) / 1_000_000n),
            chainNowMs: chainNow,
          });
    if (release !== undefined && commit !== undefined) out.tester_stalled = stallBits(release, commit);
  }

  if (policy) {
    if (!policy.key_nonces) out.gas_key_overfunded = 0n;
    else {
      const balances = await tryRead('access keys', () => gasKeyBalances(shop));
      if (balances) out.gas_key_overfunded = overfundedMicroNear(balances, BigInt(policy.key_allowance));
    }
  }
  return out;
};
