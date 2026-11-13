import cron from 'node-cron';
import { randomBytes, randomInt } from 'node:crypto';
import type { Prisma } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { chainHeadMs, chainNowMs } from '../lib/near/client.ts';
import { getAllTests, getDecision, getPayee, getPolicy, getRelease, getStatus, getTest, getTests, nsToDate, type ChainTestSlot, type DeliveryArg } from '../lib/near/shop.ts';
import { RELEASE_SETTLE_MS, releaseAtNs, releaseTicks, tickIds } from '../lib/releases.ts';
import { fromHex32, merkleProofHex, merkleRootHex, verifyMerkle } from '../lib/proof/merkle.ts';
import { receiptHashOf } from '../lib/proof/commitment.ts';
import { invoiceIdOf } from '../lib/proof/canonical.ts';
import { assertRevealGrace, tlockRoundFor } from '../lib/proof/tlock.ts';
import { candidateTicks, testDeliveryTimes } from '../utils/delivery.ts';
import { normaliseIntake } from '../utils/intake.ts';
import { createLogger, errFields, type Logger } from '../utils/logger.ts';
import { unseal } from './seal.ts';
import { buildGeneratorInput, CATEGORIES, createGenerator, type GenerationAttempt } from './generator.ts';
import { createVerifiedChat } from './nearai.ts';
import type { AiReceiptBytes } from '../lib/proof/receipt.ts';
import { makeTestSlot, makeVoidSlot, sealBatchForChain, shuffle, type Sealed } from './slots.ts';
import { finalizeInTx } from './finalize.ts';
import { shouldReveal } from './reveal.ts';
import { clockSkew, commitDue } from './chainClock.ts';
import { sampleAmount, unitsToDecimal, vendorAmounts } from './amounts.ts';
import { newTestPayee } from './payees.ts';
import { shouldAbandon, TESTER_SCHEDULES } from './recovery.ts';
import { blocklistFailedReveals } from './blocklist.ts';
import { verifyEvidence } from '../lib/blocklist/evidence.ts';
import { recordEntry } from '../lib/blocklist/store.ts';
import { attemptsToday, contexts, preflight, provisionKeys, setState, type VaultCtx } from './vaults.ts';
import { canSign, commitAllowed, lureAllowance } from './preflight.ts';
import { createQueue, forEachVault, perVaultGuard } from './runner.ts';
import { reconcileCommits, type StoppableTask } from './schedule.ts';
import {
  DELIVERY_END_HOUR_UTC,
  DELIVERY_START_HOUR_UTC,
  GENERATION_BLOCKER,
  GENERATOR_MODELS,
  NEARAI_API_KEY_TESTER,
  NEARAI_TIMEOUT_MS,
  GENERATOR_THINKING,
  NEARAI_BASE_URL,
  REAL_HISTORY_DAYS,
  RELEASE_TICK_MINUTES,
  TEST_ETH_PAYEE_PERCENT,
  TEST_SEAL_KEY,
  TESTER_MAX_LURES_PER_BATCH,
  TESTER_MAX_LURES_PER_DAY,
} from './config.ts';

type SealedRow = { id: string; commitment: string; sealed: string; runId: string; createdAt: Date };

const DAY_MS = 86_400_000;

// Built only when generation is possible; a commit that needs a test refuses otherwise.
const generate = GENERATION_BLOCKER ? null : createGenerator(createVerifiedChat({ apiKey: NEARAI_API_KEY_TESTER, baseUrl: NEARAI_BASE_URL, timeoutMs: NEARAI_TIMEOUT_MS }), GENERATOR_MODELS, { thinking: GENERATOR_THINKING });
const open = (row: { sealed: string }): Sealed => unseal<Sealed>(TEST_SEAL_KEY, row.sealed);
const pick = <T>(xs: readonly T[]): T => xs[randomInt(xs.length)];

// One guard per (job, vault): a slow vault skips only its own next run; a throw marks only that vault `error`.
const guard = <A extends unknown[]>(log: Logger, fn: (ctx: VaultCtx, ...args: A) => Promise<void>) =>
  perVaultGuard<VaultCtx, A>(log, (ctx) => setState(ctx, 'error'), fn);

// The default vault signs as before whatever its preflight says; another vault waits until its key and owner check out.
const signable = (ctx: VaultCtx): boolean => ctx.isDefault || canSign(ctx.state);

const minAnswerOf = async (shop: string): Promise<bigint> => BigInt((await getPolicy(shop)).min_answer ?? '0');

/** Release times of recent real invoices: everything delivered that is not one of our own tests. */
const realReleaseHistory = async (cid: string): Promise<Date[]> => {
  const since = new Date(Date.now() - REAL_HISTORY_DAYS * DAY_MS);
  // B23-07: a test is delivered before its expiry (commit + the vault's test_ttl), so any test released since `since` expires after it
  const ours = await prismaQuery.sealedSlot.findMany({ where: { companyId: cid, expiresAt: { gte: since } }, select: { sealed: true } });
  const testIds = new Set(ours.map((r) => open(r).invoiceId));
  const rows = await prismaQuery.invoice.findMany({ where: { companyId: cid, deliverAt: { gte: since, lte: new Date() } }, select: { invoiceId: true, deliverAt: true } });
  return rows.filter((r) => !testIds.has(r.invoiceId)).map((r) => r.deliverAt);
};

/** Moves Prepared slots to Committed, writes the public slot rows (no linkage) and releases test invoices. */
const finalize = async (
  ctx: VaultCtx,
  items: { row: SealedRow; slotIndex: number; chain: ChainTestSlot }[],
  batchTx: { txHash: string; signerId: string } | null
): Promise<number> => {
  if (items.length === 0) return 0;
  const cid = ctx.companyId;
  const expiresAt = nsToDate(items[0].chain.expires_at);
  const opened = items.map((it) => ({ ...it, s: open(it.row) }));
  const tests = opened.filter((o) => o.s.invoice);
  const realHistory = await realReleaseHistory(cid);
  const answerBy = new Date(expiresAt.getTime() - Number((await minAnswerOf(ctx.shop)) / 1_000_000n));
  // SS-B02: tests use the same release ticks as real invoices, weighted by real release hours; never past expiry (SS-B07)
  // B23-02: `now` after the slow reads; B23-03: no tick after expires_at - min_answer
  const times = testDeliveryTimes(tests.length, {
    now: new Date(),
    expiresAt,
    answerBy,
    periodMinutes: RELEASE_TICK_MINUTES,
    realHistory,
    businessStartHourUtc: DELIVERY_START_HOUR_UTC,
    businessEndHourUtc: DELIVERY_END_HOUR_UTC,
  });
  if (tests.length > 0 && times.length === 0) createLogger('tester:commit').error('no release tick before expiry; tests left undelivered', { expiresAt });
  const batchIndex = items[0].chain.batch;
  const finalized = opened.map((o) => ({ rowId: o.row.id, slotIndex: o.slotIndex, chain: o.chain, s: o.s }));
  return prismaQuery.$transaction((tx) => finalizeInTx(tx, { cid, items: finalized, times, batchIndex, expiresAt, batchTx }));
};

const recoverLog = createLogger('tester:recover');

// A crash between the commit tx and the DB write leaves committed slots that only this DB can reveal.
const recoverPreparedRun = async (ctx: VaultCtx): Promise<void> => {
  const cid = ctx.companyId;
  const prepared = await prismaQuery.sealedSlot.findMany({
    where: { companyId: cid, status: 'Prepared' },
    select: { id: true, commitment: true, sealed: true, runId: true, createdAt: true },
  });
  if (prepared.length === 0) return;
  const chain = await getAllTests(ctx.shop);
  const onChain = new Map(chain.map((s, i) => [s.commitment, { slotIndex: i, chain: s }]));
  const found = prepared.flatMap((row) => {
    const hit = onChain.get(row.commitment);
    return hit ? [{ row, ...hit }] : [];
  });
  // group by batch so each batch gets one delivery plan
  // an in-flight commitBatch may finalize the same rows; whichever transaction comes second claims nothing (B23-09)
  let committed = 0;
  for (const b of new Set(found.map((f) => f.chain.batch))) committed += await finalize(ctx, found.filter((f) => f.chain.batch === b), null);
  const stale = prepared.filter((r) => shouldAbandon(r.createdAt, Date.now(), onChain.has(r.commitment)));
  if (stale.length) await prismaQuery.sealedSlot.updateMany({ where: { id: { in: stale.map((r) => r.id) } }, data: { status: 'Abandoned' } });
  if (committed || stale.length) recoverLog.info('recovered prepared slots', { shop: ctx.shop, committed, abandoned: stale.length });
};
export const recoverPrepared = guard(recoverLog, recoverPreparedRun);

const commitLog = createLogger('tester:commit');

/**
 * One fixed-size batch of K slots; each slot is a test with `testPercent` (default: the vault's setting), else void.
 * Non-default vaults pass the full preflight first and get at most TESTER_MAX_LURES_PER_BATCH lures within the daily budget.
 */
export const commitBatch = guard(commitLog, async (ctx: VaultCtx, o: { testPercent?: number } = {}) => {
  const testPercent = o.testPercent ?? ctx.testPercent;
  if (testPercent > 0 && !generate) return commitLog.error('refusing to commit: tests need generation', { shop: ctx.shop, blocker: GENERATION_BLOCKER, testPercent });
  if (!ctx.isDefault) {
    if (!ctx.enabled) return commitLog.info('testing not enabled or over capacity; no commit', { shop: ctx.shop });
    const state = await preflight(ctx, true);
    if (!commitAllowed(state)) return commitLog.info('preflight refused the commit', { shop: ctx.shop, state });
  }
  await recoverPreparedRun(ctx);
  const SHOP = ctx.shop;
  const company = await prismaQuery.company.findUniqueOrThrow({ where: { id: ctx.companyId }, include: { vendors: true } });
  const policy = await getPolicy(SHOP);
  const all = await getAllTests(SHOP);
  // chain time decides due, expiry and round: a skewed host clock would otherwise stall commits with no error
  const chainNow = await chainNowMs();
  const skewMs = clockSkew(Date.now(), chainNow);
  if (skewMs !== null) commitLog.warn('host clock differs from chain time; using chain time', { skewMs });
  const { due, dueNs } = commitDue(all.length ? all[all.length - 1].committed_at : null, policy.batch_interval, chainNow);
  if (!due) return commitLog.info('next batch not due', { dueAt: nsToDate(dueNs!).toISOString() });
  if (company.vendors.length === 0) return commitLog.warn('no vendors on record; cannot write tests');
  const ttlMs = Number(BigInt(policy.test_ttl) / 1_000_000n);
  const graceMs = Number(BigInt(policy.reveal_grace) / 1_000_000n);
  assertRevealGrace(graceMs); // V2-01
  const answerMs = Number(BigInt(policy.min_answer ?? '0') / 1_000_000n);
  // `now` stays the host clock: the API delivers by it; expiry and the answer deadline are chain-relative
  if (candidateTicks({ now: new Date(), expiresAt: new Date(chainNow + ttlMs), answerBy: new Date(chainNow + ttlMs - answerMs), periodMinutes: RELEASE_TICK_MINUTES }).length === 0) {
    return commitLog.error('test_ttl and min_answer leave no release tick for a test; refusing to commit', { ttlMs, answerMs, RELEASE_TICK_MINUTES });
  }

  const runId = randomBytes(8).toString('hex');
  let position = 0;
  // the default vault is not budgeted (unchanged); others share TESTER_MAX_LURES_PER_DAY generation calls
  const usedToday = ctx.isDefault ? 0 : await attemptsToday();
  const lureSlots = lureAllowance(ctx.isDefault, policy.batch_size, TESTER_MAX_LURES_PER_BATCH, usedToday, TESTER_MAX_LURES_PER_DAY);
  const budgetLeft = () => ctx.isDefault || usedToday + position < TESTER_MAX_LURES_PER_DAY;
  let lures = 0;
  // B9: every signed generation, kept or discarded, goes into the run's log (tester schema until the batch is revealed)
  const onAttempt = async (a: GenerationAttempt): Promise<string> => {
    const row = await prismaQuery.generationAttempt.create({
      data: { companyId: company.id, runId, position: position++, model: a.model, receiptHash: a.receiptHash, accepted: a.accepted, error: a.error, receipt: { ...a.receipt, attestation: a.attestation } as unknown as Prisma.InputJsonValue },
      select: { id: true },
    });
    return row.id;
  };

  const built = [];
  for (let i = 0; i < policy.batch_size; i++) {
    if (randomInt(100) >= testPercent || !generate || lures >= lureSlots || !budgetLeft()) {
      built.push(makeVoidSlot(TEST_SEAL_KEY));
      continue;
    }
    lures++;
    const vendor = pick(company.vendors);
    const payee = newTestPayee(TEST_ETH_PAYEE_PERCENT);
    const category = pick(CATEGORIES);
    try {
      const payeeAccounts = (vendor.approvedPayees as { account: string }[]).map((p) => p.account);
      const history = await prismaQuery.payment.findMany({ where: { companyId: company.id, payee: { in: payeeAccounts }, byOwner: false }, select: { amount: true }, take: 50, orderBy: { createdAt: 'desc' } });
      const amount = sampleAmount(vendorAmounts(history, vendor.styleSet as unknown[], ctx.decimals), BigInt(policy.max_per_payment), ctx.decimals);
      let acceptedId: string | null = null;
      const { draft, receipt } = await generate!(
        buildGeneratorInput({ company: company.name, category, vendor, payee: payee.payee, amount, maxTotal: unitsToDecimal(BigInt(policy.max_per_payment), ctx.decimals) }),
        async (a) => {
          const id = await onAttempt(a);
          if (a.accepted) acceptedId = id;
        }
      );
      // same vendor_id rule and normaliser as real intake, so the document shape cannot tell them apart
      const { document, email } = normaliseIntake({ document: { ...draft.invoice, vendor_id: vendor.id }, email: draft.email });
      const invoiceId = invoiceIdOf(document);
      if (await prismaQuery.invoice.findUnique({ where: { invoiceId }, select: { id: true } })) throw new Error('invoice id collision');
      built.push(
        makeTestSlot(TEST_SEAL_KEY, {
          payee: payee.payee,
          payeeSecret: payee.secret,
          payeeKind: payee.kind,
          invoiceId,
          receiptHash: receiptHashOf((receipt as AiReceiptBytes).signedText),
          attemptId: acceptedId ?? undefined,
          category,
          invoice: { document, email },
        })
      );
    } catch (error) {
      // keep the daily cadence: an ungenerated test becomes a void slot
      commitLog.warn('test generation failed, slot committed as void', { category, ...errFields(error) });
      built.push(makeVoidSlot(TEST_SEAL_KEY));
    }
  }
  const slots = shuffle(built);

  // B8 / V2-01: seal to the first drand round after expiry. Persist before the tx so a crash can be recovered.
  let round = tlockRoundFor(await chainHeadMs(), ttlMs, graceMs);
  let { args, ciphertexts } = await sealBatchForChain(slots, round);
  const rows: SealedRow[] = await prismaQuery.$transaction(
    slots.map((s, i) =>
      prismaQuery.sealedSlot.create({
        data: { companyId: company.id, runId, commitment: s.commitment, sealed: s.sealed, ciphertext: ciphertexts[i], ciphertextSha256: args[i].ciphertext_sha256, tlockRound: BigInt(round) },
        select: { id: true, commitment: true, sealed: true, runId: true, createdAt: true },
      })
    )
  );
  let committed: { txHash: string; firstSlot: number } | null = null;
  for (let attempt = 0; attempt < 2 && !committed; attempt++) {
    try {
      committed = await ctx.chain.commitBatchTx(args, ciphertexts);
    } catch (error) {
      // sealing plus a block slower than the margin pushes expiry past our round: re-seal once with a fresh round
      if (attempt > 0 || !/tlock round must open/.test((error as Error).message)) throw error;
      commitLog.warn('tlock round rejected, re-sealing with a fresh round', { round });
      round = tlockRoundFor(await chainHeadMs(), ttlMs, graceMs);
      ({ args, ciphertexts } = await sealBatchForChain(slots, round));
      await prismaQuery.$transaction(
        rows.map((r, i) =>
          prismaQuery.sealedSlot.update({ where: { id: r.id }, data: { ciphertext: ciphertexts[i], ciphertextSha256: args[i].ciphertext_sha256, tlockRound: BigInt(round) } })
        )
      );
    }
  }
  const { txHash, firstSlot } = committed!;
  const chainSlots = await getTests(SHOP, firstSlot, rows.length);
  await finalize(ctx, rows.map((row, i) => ({ row, slotIndex: firstSlot + i, chain: chainSlots[i] })), { txHash, signerId: ctx.signerId });
  commitLog.info('batch committed', { shop: SHOP, txHash, firstSlot, count: rows.length, tlockRound: round, attempts: position, testPercent });
});

const revealLog = createLogger('tester:reveal');
const releaseLog = createLogger('tester:release');
const RELEASE_PAGE = 100;

const atLeast = (version: string, min: [number, number]): boolean => {
  const [a, b] = version.split('.').map(Number);
  return a !== min[0] ? a > min[0] : b >= min[1];
};

// Delivery proof: one release(root) per tick once its items are visible to the agent, real and test alike.
export const postReleases = guard(releaseLog, async (ctx: VaultCtx) => {
  if (!signable(ctx)) return releaseLog.debug('tester key not usable; skipping', { shop: ctx.shop, state: ctx.state });
  const SHOP = ctx.shop;
  const posted = ctx.posted; // release_at (ns) known to be on chain, so a run does not re-view old ticks
  const status = await getStatus(SHOP);
  if (!atLeast(status.version, [2, 3])) return releaseLog.debug('vault has no release method', { shop: SHOP, version: status.version });
  const cid = ctx.companyId;
  const policy = await getPolicy(SHOP);
  // an older tick cannot prove delivery of any open lure: release_at must be at or after the slot's commit
  const chainNow = await chainNowMs();
  const since = new Date(chainNow - Number(BigInt(policy.test_ttl) / 1_000_000n));
  // release_at must not pass chain time: take the earlier of our clock and the final block time
  const until = new Date(Math.min(Date.now(), chainNow) - RELEASE_SETTLE_MS);
  for (const at of posted) if (BigInt(at) < BigInt(releaseAtNs(since))) posted.delete(at);
  for (let from = since; ; ) {
    const ticks = await releaseTicks(cid, from, until, RELEASE_PAGE);
    for (const t of ticks) {
      const at = releaseAtNs(t.releaseAt);
      if (posted.has(at)) continue;
      try {
        const root = merkleRootHex(t.ids);
        const onChain = await getRelease(SHOP, at);
        if (!onChain) {
          const { txHash } = await ctx.chain.releaseTx(at, root, t.ids.length);
          releaseLog.info('release posted', { shop: SHOP, releaseAt: t.releaseAt.toISOString(), count: t.ids.length, root, txHash });
        } else if (onChain.root !== root || onChain.count !== t.ids.length) {
          // B23-05: the tick changed after posting; no lure in it can be proven delivered
          releaseLog.error('posted release differs from the tick in the database', { releaseAt: t.releaseAt.toISOString(), chainRoot: onChain.root, chainCount: onChain.count, dbRoot: root, dbCount: t.ids.length });
        }
        posted.add(at);
      } catch (error) {
        releaseLog.error('release failed', { releaseAt: t.releaseAt.toISOString(), count: t.ids.length, ...errFields(error) });
      }
    }
    if (ticks.length < RELEASE_PAGE) return;
    from = new Date(ticks[ticks.length - 1].releaseAt.getTime() + 1);
  }
});

/**
 * Delivery proof for an undecided lure, only when every check the contract makes holds (an invalid proof
 * panics the reveal). Null means reveal without it: the slot is then Unanswered, as before contract 2.3.0.
 */
const deliveryFor = async (ctx: VaultCtx, invoiceId: string, slot: ChainTestSlot, minAnswerNs: bigint): Promise<DeliveryArg | null> => {
  const cid = ctx.companyId;
  const SHOP = ctx.shop;
  const inv = await prismaQuery.invoice.findUnique({ where: { invoiceId }, select: { companyId: true, deliverAt: true } });
  if (!inv || inv.companyId !== cid) return null; // never delivered
  if ((await getDecision(SHOP, invoiceId)) !== null) return null; // any decision, any time, rules out Ignored (V23-04)
  const at = releaseAtNs(inv.deliverAt);
  const [rel, status] = await Promise.all([getRelease(SHOP, at), getStatus(SHOP)]);
  if (!rel?.ack || rel.ack.root !== rel.root) return null; // not acked, or the agent saw another inbox
  // V23-07: the ack must come from the key armed now, signed after that arming, with no freeze in the window
  if (status.mode !== 'Armed' && status.mode !== 'Demoted') return null;
  if (rel.ack.key !== status.agent_key || BigInt(status.armed_at) > BigInt(rel.ack.at)) return null;
  const deadline = BigInt(slot.expires_at) - minAnswerNs;
  if (BigInt(at) < BigInt(slot.committed_at) || BigInt(at) > deadline || BigInt(rel.ack.at) > deadline) return null;
  const frozenAt = BigInt(status.frozen_at ?? '0');
  if (frozenAt !== 0n && frozenAt > BigInt(rel.ack.at) && frozenAt <= deadline) return null; // (ack.at, deadline]
  const ids = await tickIds(cid, inv.deliverAt);
  const { index, proof } = merkleProofHex(ids, invoiceId);
  if (!verifyMerkle(fromHex32(rel.root), fromHex32(invoiceId), index, proof.map(fromHex32), rel.count)) {
    revealLog.warn('tick in the database does not match the posted release root', { releaseAt: inv.deliverAt.toISOString(), dbCount: ids.length, chainCount: rel.count });
    return null;
  }
  return { release_at: at, index, proof };
};

/**
 * Upgrades an Unanswered lure to Ignored with prove_delivery when its tick was acked in time. Skips anything else.
 * After expiry the answer window is closed, so a slot that had no valid proof once never gets one (ctx.noProof).
 */
const proveIfDelivered = async (ctx: VaultCtx, slotIndex: number, chain: ChainTestSlot, minAnswerNs: bigint): Promise<void> => {
  const { companyId: cid, noProof } = ctx;
  if (chain.status !== 'Unanswered' || !chain.reveal?.payee || noProof.has(slotIndex)) return;
  const delivery = await deliveryFor(ctx, chain.reveal.invoice_id, chain, minAnswerNs);
  if (!delivery) {
    noProof.add(slotIndex);
    return;
  }
  try {
    const { txHash, status } = await ctx.chain.proveDeliveryTx(slotIndex, delivery);
    await prismaQuery.testSlot.updateMany({ where: { companyId: cid, slotIndex }, data: { status } });
    revealLog.info('delivery proven', { shop: ctx.shop, slotIndex, status, txHash, releaseAt: delivery.release_at });
  } catch (error) {
    // e.g. a twin lure on the same invoice already scored: the contract refuses, and so will every retry
    noProof.add(slotIndex);
    revealLog.error('prove_delivery refused', { slotIndex, releaseAt: delivery.release_at, ...errFields(error) });
  }
};

// Catches Unanswered slots revealed while the tester was down, by the keeper or anyone (V23-02).
export const proveDeliveries = guard(revealLog, async (ctx: VaultCtx) => {
  if (!signable(ctx)) return;
  const SHOP = ctx.shop;
  const noProof = ctx.noProof;
  const status = await getStatus(SHOP);
  if (!atLeast(status.version, [2, 3])) return;
  const cid = ctx.companyId;
  const rows = await prismaQuery.testSlot.findMany({
    where: { companyId: cid, status: 'Unanswered', slotIndex: { not: null } },
    select: { slotIndex: true },
    orderBy: { slotIndex: 'desc' },
    take: 500,
  });
  const open = rows.map((r) => r.slotIndex!).filter((i) => !noProof.has(i));
  if (open.length === 0) return;
  const minAnswerNs = await minAnswerOf(SHOP);
  for (const slotIndex of open) {
    try {
      const chain = await getTest(SHOP, slotIndex);
      if (!chain) continue;
      if (chain.status !== 'Unanswered') {
        // already Ignored (another prover) or never Unanswered on chain: mirror the chain
        await prismaQuery.testSlot.updateMany({ where: { companyId: cid, slotIndex }, data: { status: chain.status } });
        continue;
      }
      await proveIfDelivered(ctx, slotIndex, chain, minAnswerNs);
    } catch (error) {
      revealLog.error('delivery proof check failed', { shop: SHOP, slotIndex, ...errFields(error) });
    }
  }
});

/** Writes the revealed preimage and, for tests, the now-public linkage and AI receipt. */
const publish = async (cid: string, row: { id: string; slotIndex: number; sealed: string }, c: ChainTestSlot, revealTxHash: string | null): Promise<void> => {
  const s = open(row);
  const [invoice, attempt] = await Promise.all([
    s.invoice ? prismaQuery.invoice.findUnique({ where: { invoiceId: s.invoiceId }, select: { id: true } }) : null,
    s.attemptId ? prismaQuery.generationAttempt.findUnique({ where: { id: s.attemptId } }) : null,
  ]);
  let aiReceiptId: string | null = null;
  if (attempt) {
    const r = attempt.receipt as unknown as AiReceiptBytes & { attestation?: Prisma.InputJsonValue };
    const pub = await prismaQuery.aiReceipt.upsert({
      where: { responseId: r.responseId },
      create: {
        companyId: cid,
        purpose: 'test_generation',
        responseId: r.responseId,
        model: r.model,
        signatureKind: r.signatureKind,
        signingAlgo: r.signingAlgo,
        signingAddress: r.signingAddress,
        signedText: r.signedText,
        signature: r.signature,
        requestBody: r.requestBody,
        responseBody: r.responseBody,
        ...(r.attestation ? { attestation: r.attestation } : {}),
      },
      update: {},
      select: { id: true },
    });
    aiReceiptId = pub.id;
  }
  await prismaQuery.testSlot.update({
    where: { companyId_slotIndex: { companyId: cid, slotIndex: row.slotIndex } },
    data: {
      status: c.status,
      contained: c.contained,
      revealedPayee: s.payee,
      revealedSalt: s.salt,
      revealedInvoiceId: s.invoiceId,
      receiptHash: s.receiptHash,
      revealTxHash: revealTxHash ?? undefined,
      revealedAt: c.reveal ? nsToDate(c.reveal.at) : new Date(),
      invoiceRowId: invoice?.id ?? null,
      aiReceiptId,
    },
    select: { id: true },
  });
  await prismaQuery.sealedSlot.update({ where: { id: row.id }, data: { status: 'Revealed' } });
};

// B9: publish a run's generation log once every slot of its batch is revealed (earlier would leak the test count).
const publishGenLogs = async (cid: string): Promise<void> => {
  const runs = await prismaQuery.sealedSlot.groupBy({ by: ['runId', 'batchIndex'], where: { companyId: cid, batchIndex: { not: null } } });
  for (const { runId, batchIndex } of runs) {
    if (batchIndex === null) continue;
    const open = await prismaQuery.sealedSlot.count({ where: { companyId: cid, runId, status: { in: ['Prepared', 'Committed'] } } });
    if (open > 0) continue;
    if (await prismaQuery.genLogEntry.findFirst({ where: { companyId: cid, batchIndex }, select: { id: true } })) continue;
    const attempts = await prismaQuery.generationAttempt.findMany({ where: { companyId: cid, runId }, orderBy: { position: 'asc' } });
    await prismaQuery.genLogEntry.createMany({
      data: attempts.map((a) => ({ companyId: cid, batchIndex, position: a.position, receiptHash: a.receiptHash, model: a.model, accepted: a.accepted })),
      skipDuplicates: true,
    });
    revealLog.info('generation log published', { batchIndex, attempts: attempts.length });
  }
};

// Touched tests are revealed at once (Failed or Invalid); the rest once chain time passes expiry.
// Runs for every vault with open slots, enabled or not: disabling testing never strands a sealed slot.
export const revealWatcher = guard(revealLog, async (ctx: VaultCtx) => {
  if (!signable(ctx)) return revealLog.debug('tester key not usable; the keeper reveals after the tlock round', { shop: ctx.shop, state: ctx.state });
  const SHOP = ctx.shop;
  const cid = ctx.companyId;
  const openSlots = await prismaQuery.sealedSlot.findMany({
    where: { companyId: cid, status: 'Committed', slotIndex: { not: null } },
    select: { id: true, slotIndex: true, sealed: true },
    orderBy: { slotIndex: 'asc' },
  });
  const now = await chainNowMs();
  let minAnswerNs: bigint | null = null;
  const minAnswer = async (): Promise<bigint> => (minAnswerNs ??= await minAnswerOf(SHOP));
  for (const r of openSlots) {
    const row = { ...r, slotIndex: r.slotIndex! };
    try {
      const chain = await getTest(SHOP, row.slotIndex);
      if (!chain) {
        revealLog.warn('slot missing on chain', { slotIndex: row.slotIndex });
        continue;
      }
      if (chain.status !== 'Committed') {
        await publish(cid, row, chain, null); // revealed by someone else (keeper or stranger): reveal is permissionless
        await proveIfDelivered(ctx, row.slotIndex, chain, await minAnswer());
        continue;
      }
      const s = open(row);
      const touched = s.payee ? await getPayee(SHOP, s.payee) : null;
      if (!shouldReveal(s, chain, touched, now)) continue;
      // an expired lure with no decision: Ignored if its tick was acked, else Unanswered (deliveryFor checks the decision)
      const delivery = s.payee && !touched ? await deliveryFor(ctx, s.invoiceId, chain, await minAnswer()) : null;
      let revealed;
      try {
        revealed = await ctx.chain.revealTx(row.slotIndex, s.salt, s.payee, s.invoiceId, s.receiptHash, delivery ?? undefined);
      } catch (error) {
        if (!delivery) throw error;
        // a refused proof must not leave the slot overdue; anyone may still upgrade it later with prove_delivery
        revealLog.error('reveal with delivery proof refused, revealing without it', { slotIndex: row.slotIndex, releaseAt: delivery.release_at, ...errFields(error) });
        revealed = await ctx.chain.revealTx(row.slotIndex, s.salt, s.payee, s.invoiceId, s.receiptHash);
      }
      const { txHash, status } = revealed;
      const after = (await getTest(SHOP, row.slotIndex)) ?? chain;
      await publish(cid, row, after, txHash);
      revealLog.info('slot revealed', { shop: SHOP, slotIndex: row.slotIndex, status, txHash, early: !!touched, deliveryProof: !!delivery });
      await proveIfDelivered(ctx, row.slotIndex, after, await minAnswer()); // only acts if it came out Unanswered
    } catch (error) {
      revealLog.error('reveal failed', { shop: SHOP, slotIndex: row.slotIndex, ...errFields(error) });
    }
  }
  await publishGenLogs(cid);
  await blocklistFailed(ctx);
});

const BLOCKLIST_PER_RUN = 20;

// Failed reveals go on the shared blocklist with their reveal tx as evidence; listed ones are skipped by the query.
const blocklistFailed = async (ctx: VaultCtx): Promise<void> => {
  const cid = ctx.companyId;
  await blocklistFailedReveals({
    failedReveals: async () =>
      (
        await prismaQuery.testSlot.findMany({
          where: { companyId: cid, status: 'Failed', revealTxHash: { not: null }, revealedPayee: { not: null }, slotIndex: { not: null } },
          orderBy: { slotIndex: 'desc' },
          take: BLOCKLIST_PER_RUN,
          select: { slotIndex: true, revealedPayee: true, revealTxHash: true },
        })
      ).map((r) => ({ slotIndex: r.slotIndex!, payee: r.revealedPayee!, revealTxHash: r.revealTxHash! })),
    listed: async (accountId, evidenceTx) =>
      !!(await prismaQuery.blocklistEntry.findUnique({ where: { accountId_evidenceTx: { accountId, evidenceTx } }, select: { id: true } })),
    verify: (accountId, evidenceTx) => verifyEvidence(accountId, evidenceTx, ctx.evidence),
    record: recordEntry,
    reporterId: ctx.signerId,
    vault: ctx.shop,
    log: revealLog,
  });
};

const sweepLog = createLogger('tester:sweep');

export const sweep = guard(sweepLog, async (ctx: VaultCtx) => {
  const sweepPayee = ctx.sweep;
  if (!sweepPayee) return;
  const cid = ctx.companyId;
  const failed = await prismaQuery.testSlot.findMany({
    where: { companyId: cid, status: 'Failed', sweptTxHash: null, revealedPayee: { not: null } },
    select: { id: true, slotIndex: true, commitment: true },
  });
  for (const row of failed) {
    try {
      const sealedRow = await prismaQuery.sealedSlot.findUnique({ where: { commitment: row.commitment }, select: { sealed: true } });
      if (!sealedRow) continue;
      const s = open(sealedRow);
      if (!s.payeeSecret || !s.payee) continue;
      // eth-implicit payees hold funds behind a wallet contract that needs an Ethereum-signed tx; not swept here
      if (s.payeeKind === 'eth_implicit') {
        sweepLog.warn('eth-implicit payee not swept automatically', { slotIndex: row.slotIndex });
        continue;
      }
      const txHash = await sweepPayee(s.payee, s.payeeSecret, row.slotIndex!);
      if (!txHash) continue; // nothing arrived yet (pending transfer, or a contained proposal never approved)
      await prismaQuery.testSlot.update({ where: { id: row.id }, data: { sweptTxHash: txHash }, select: { id: true } });
      sweepLog.info('swept', { shop: ctx.shop, slotIndex: row.slotIndex, txHash });
    } catch (error) {
      sweepLog.error('sweep failed', { shop: ctx.shop, slotIndex: row.slotIndex, ...errFields(error) });
    }
  }
});

const testerLog = createLogger('tester');
const each = (job: (ctx: VaultCtx) => Promise<void>) => forEachVault(contexts, job, testerLog);
const commitQueue = createQueue(commitLog);
const commitTasks = new Map<string, { cron: string; task: StoppableTask }>();

// Multi-vault: a commit task per vault on its own cron, all through one queue (generation shares one NEAR AI key).
const reconcileCommitTasks = async (): Promise<void> => {
  const list = await contexts();
  // without generation a scheduled default batch would be all voids: commit nothing rather than a hollow scorecard
  const wanted = list.filter((c) => c.enabled && (generate || !c.isDefault)).map((c) => ({ shop: c.shop, cron: c.commitCron }));
  const changed = reconcileCommits(commitTasks, wanted, ({ shop, cron: expr }) =>
    cron.schedule(expr, () => void commitQueue(shop, async () => {
      const ctx = (await contexts()).find((c) => c.shop === shop);
      if (ctx) await commitBatch(ctx);
    }), { timezone: 'UTC' })
  );
  if (changed.added.length || changed.replaced.length || changed.stopped.length) testerLog.info('commit schedules', changed);
};

// Every 5 minutes: reload vaults, record each vault's state (the default vault's only for the API), then the cron tasks.
const refreshVaults = async (): Promise<void> => {
  for (const ctx of await contexts(true)) {
    try {
      await preflight(ctx, ctx.enabled && !ctx.isDefault);
    } catch (error) {
      testerLog.error('preflight failed', { shop: ctx.shop, ...errFields(error) });
      await setState(ctx, 'error').catch(() => undefined);
    }
  }
  await reconcileCommitTasks();
};

/** Startup catch-up for every vault but the default (which tester.ts runs first and fatally). Never throws. */
export const recoverOtherVaults = async (): Promise<void> => {
  const others = forEachVault(async () => (await contexts()).filter((c) => !c.isDefault), async (ctx) => {
    await recoverPrepared(ctx);
    await postReleases(ctx);
    await revealWatcher(ctx);
    await proveDeliveries(ctx);
  }, testerLog);
  await others();
};

export const startTesterWorkers = async (): Promise<StoppableTask[]> => {
  const tasks: StoppableTask[] = [
    cron.schedule(TESTER_SCHEDULES.reveal, each(revealWatcher)),
    cron.schedule(TESTER_SCHEDULES.recover, each(recoverPrepared)), // SS-B07: not only at the next daily commit
    cron.schedule(TESTER_SCHEDULES.recover, each(proveDeliveries)), // V23-02: Unanswered slots revealed while we were down
    cron.schedule(TESTER_SCHEDULES.release, each(postReleases)),
    cron.schedule(TESTER_SCHEDULES.sweep, each(sweep)),
    cron.schedule(TESTER_SCHEDULES.keys, () => void provisionKeys().catch((error) => testerLog.error('key provisioning failed', errFields(error)))),
    cron.schedule(TESTER_SCHEDULES.vaults, () => void refreshVaults().catch((error) => testerLog.error('vault refresh failed', errFields(error)))),
    { stop: () => commitTasks.forEach((t) => t.task.stop()) },
  ];
  if (!generate) testerLog.warn('scheduled commits disabled for the default vault', { blocker: GENERATION_BLOCKER });
  await provisionKeys().catch((error) => testerLog.error('key provisioning failed', errFields(error)));
  await refreshVaults();
  testerLog.info('workers scheduled', { ...TESTER_SCHEDULES, commits: [...commitTasks].map(([shop, t]) => ({ shop, cron: t.cron })) });
  void each(revealWatcher)();
  return tasks;
};
