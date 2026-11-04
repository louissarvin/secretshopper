// Tester process (owner side): `bun --env-file=.env.tester tester.ts`. Holds the seal key; the API never imports this tree.
import { prismaQuery } from './src/lib/prisma.ts';
import { getPolicy, getStatus, writeHeadroom } from './src/lib/near/shop.ts';
import { rpc } from './src/lib/near/client.ts';
import { assertRevealGrace } from './src/lib/proof/tlock.ts';
import { createLogger, errFields } from './src/utils/logger.ts';
import cron from 'node-cron';
import { COMMIT_CRON, NEAR, SHOP_CONTRACT_ID, TESTER_ACCOUNT_ID, TESTER_KEY_SEED, USDC_CONTRACT_ID } from './src/tester/config.ts';
import { commitBatch, postReleases, proveDeliveries, recoverOtherVaults, recoverPrepared, revealWatcher, startTesterWorkers } from './src/tester/workers.ts';
import { contexts } from './src/tester/vaults.ts';
import { GENERATION_BLOCKER, TEST_PROBABILITY_PERCENT } from './src/tester/config.ts';

const log = createLogger('tester');

// CLI: --commit-now [--test-percent=N] [--once] [--shop=<vault>]. --once: recover, one reveal pass, optional commit, exit.
// --test-percent overrides the vault's test share for this run only; --shop picks the vault for --commit-now (default SHOP_CONTRACT_ID).
const flag = (name: string): string | undefined => {
  const a = process.argv.find((x) => x === name || x.startsWith(`${name}=`));
  return a === undefined ? undefined : (a.split('=')[1] ?? '');
};
const testPercentArg = flag('--test-percent');
const testPercent = testPercentArg === undefined ? TEST_PROBABILITY_PERCENT : Number(testPercentArg);
if (!Number.isInteger(testPercent) || testPercent < 0 || testPercent > 100) {
  log.error('fatal', { err: '--test-percent must be an integer 0..100' });
  process.exit(1);
}
const once = flag('--once') !== undefined;
const shopArg = flag('--shop') || SHOP_CONTRACT_ID;

const main = async (): Promise<void> => {
  if (!cron.validate(COMMIT_CRON)) throw new Error(`invalid TESTER_COMMIT_CRON: ${COMMIT_CRON}`);
  // Refuse to run against the wrong vault, owner or token. These checks cover the default vault and stay fatal.
  const status = await getStatus(SHOP_CONTRACT_ID);
  if (status.owner_id !== TESTER_ACCOUNT_ID) throw new Error(`TESTER_ACCOUNT_ID ${TESTER_ACCOUNT_ID} is not the vault owner (${status.owner_id})`);
  if (status.token_id !== USDC_CONTRACT_ID) throw new Error(`USDC_CONTRACT_ID ${USDC_CONTRACT_ID} differs from the vault token (${status.token_id})`);
  const company = await prismaQuery.company.findUnique({ where: { shopContractId: SHOP_CONTRACT_ID }, select: { id: true } });
  if (!company) throw new Error('company not registered: sign in on the web and register the vault first');
  if (!/^2\./.test(status.version ?? '')) throw new Error(`vault version ${status.version ?? '1.x'} is not v2; this tester speaks v2 only`);
  const policy = await getPolicy(SHOP_CONTRACT_ID);
  assertRevealGrace(Number(BigInt(policy.reveal_grace) / 1_000_000n)); // V2-01
  // V2-09: commits and agent calls fail once the vault eats into its reveal float; warn before that happens
  const acct = await rpc.viewAccount({ accountId: SHOP_CONTRACT_ID });
  const headroom = writeHeadroom(BigInt(acct.amount), acct.storage_usage, BigInt(policy.min_near_float), {
    // get_status has no open_slots view, so this counts our unrevealed rows; a keeper's reveals catch up within one pass
    openSlots: await prismaQuery.testSlot.count({ where: { companyId: company.id, status: 'Committed' } }),
    armedGasKey: status.mode === 'Armed' && (policy.key_nonces ?? 0) > 0,
    keyAllowanceYocto: BigInt(policy.key_allowance),
  });
  const LOW = 10n ** 23n; // 0.1 NEAR: about 10 KB, roughly ten batch commits or eighteen reveals
  if (headroom < LOW) log.warn('vault NEAR near the reveal float: top it up', { shop: SHOP_CONTRACT_ID, headroom_yocto: headroom.toString() });

  const def = (await contexts(true)).find((c) => c.isDefault)!;
  await recoverPrepared(def); // SS-B07: recover a crashed commit before anything else
  await postReleases(def); // v2/32: post roots for ticks released while the tester was down
  await revealWatcher(def); // catch up on reveals (ours or a keeper's) missed while the tester was down
  await proveDeliveries(def); // V23-02: upgrade any Unanswered slot whose tick the agent acked
  await recoverOtherVaults(); // v2/37: same catch-up for every other vault, never fatal

  if (GENERATION_BLOCKER) log.warn('test generation disabled', { blocker: GENERATION_BLOCKER });
  if (!TESTER_KEY_SEED) log.info('TESTER_KEY_SEED not set: serving the default vault only');
  const commitNow = async (): Promise<void> => {
    const ctx = (await contexts()).find((c) => c.shop === shopArg);
    if (!ctx) throw new Error(`--shop ${shopArg} is not a vault this tester serves`);
    await commitBatch(ctx, { testPercent: testPercentArg === undefined ? (ctx.isDefault ? testPercent : undefined) : testPercent });
  };
  if (once) {
    if (flag('--commit-now') !== undefined) await commitNow();
    await prismaQuery.$disconnect();
    process.exit(0);
  }
  const tasks = await startTesterWorkers();
  log.info('started', { network: NEAR.network, shop: SHOP_CONTRACT_ID, mode: status.mode, testPercent });
  if (flag('--commit-now') !== undefined) await commitNow();

  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutting down', { signal });
    tasks.forEach((t) => t.stop());
    await prismaQuery.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
};

main().catch((error) => {
  log.error('fatal', errFields(error));
  process.exit(1);
});
