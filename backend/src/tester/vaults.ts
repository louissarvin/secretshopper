import cron from 'node-cron';
import { Account, type KeyPairString } from 'near-api-js';
import { z } from 'zod';
import { prismaQuery } from '../lib/prisma.ts';
import { failoverRpc, rpc, view } from '../lib/near/client.ts';
import { getPolicy, getStatus, writeHeadroom } from '../lib/near/shop.ts';
import { checkTesterKey, type OwnerKeyEntry, type TesterState } from '../lib/proof/testerKey.ts';
import { assertRevealGrace } from '../lib/proof/tlock.ts';
import { evidenceReads } from '../lib/blocklist/chainReads.ts';
import type { EvidenceReads } from '../lib/blocklist/evidence.ts';
import { candidateTicks } from '../utils/delivery.ts';
import { createLogger, errFields } from '../utils/logger.ts';
import { createSweeper, createTesterChain, type TesterChain } from './chain.ts';
import { publicKeyOf, testerKeyFor } from './keys.ts';
import { decidePreflight, lureAllowance, withinCapacity, type PreflightFacts } from './preflight.ts';
import { COMMIT_CRON_RE } from './schedule.ts';
import {
  COMMIT_CRON,
  COMMIT_TGAS,
  NEAR,
  RELEASE_TICK_MINUTES,
  REVEAL_TGAS,
  SHOP_CONTRACT_ID,
  SWEEP_FUND_NEAR,
  SWEEP_FUNDER_ID,
  SWEEP_FUNDER_KEY,
  TEST_PROBABILITY_PERCENT,
  TESTER_ACCOUNT_ID,
  TESTER_KEY_SEED,
  TESTER_MAX_BATCH_SIZE,
  TESTER_MAX_LURES_PER_DAY,
  TESTER_MAX_VAULTS,
  TESTER_MIN_ALLOWANCE_YOCTO,
  TESTER_PRIVATE_KEY,
  TOKEN_DECIMALS,
  USDC_CONTRACT_ID,
} from './config.ts';

const log = createLogger('tester:vaults');
const DAY_MS = 86_400_000;

export interface VaultCtx {
  companyId: string;
  shop: string;
  isDefault: boolean;
  signerId: string;
  publicKey: string;
  chain: TesterChain;
  sweep: ReturnType<typeof createSweeper> | null;
  tokenId: string;
  decimals: number;
  testPercent: number;
  commitCron: string;
  enabled: boolean; // may commit: the default vault always, others when enabled and within TESTER_MAX_VAULTS
  evidence: EvidenceReads;
  posted: Set<string>; // release_at (ns) known on chain
  noProof: Set<number>; // slots that can never get a delivery proof
  state: TesterState | null; // last preflight, null before the first
}

const ftMetadata = z.object({ decimals: z.number().int().min(0).max(38) });
const decimalsCache = new Map<string, { at: number; decimals: number }>();
const decimalsOf = async (tokenId: string): Promise<number> => {
  const hit = decimalsCache.get(tokenId);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.decimals;
  const { decimals } = ftMetadata.parse(await view<unknown>(tokenId, 'ft_metadata'));
  decimalsCache.set(tokenId, { at: Date.now(), decimals });
  return decimals;
};

// Per-shop state that must outlive a reload: one Account per signer key (its nonce manager), posted ticks, proof misses.
const cache = new Map<string, VaultCtx>();

const signerFor = (shop: string, signerId: string, privateKey: string, publicKey: string, tokenId: string) => {
  const prev = cache.get(shop);
  if (prev && prev.signerId === signerId && prev.publicKey === publicKey && prev.tokenId === tokenId) return { chain: prev.chain, sweep: prev.sweep };
  const chain = createTesterChain({
    tester: new Account(signerId, failoverRpc, privateKey as KeyPairString),
    shopId: shop,
    commitTgas: Number(COMMIT_TGAS),
    revealTgas: Number(REVEAL_TGAS),
  });
  const sweep = SWEEP_FUNDER_ID
    ? createSweeper({
        funder: new Account(SWEEP_FUNDER_ID, failoverRpc, SWEEP_FUNDER_KEY as KeyPairString),
        provider: rpc, // single provider: failover wraps "account does not exist" and the sweeper would never fund the payee
        tokenId,
        shopId: shop,
        fundNear: SWEEP_FUND_NEAR,
      })
    : null;
  return { chain, sweep };
};

const validCron = (c: string | null): string => (c && COMMIT_CRON_RE.test(c) && cron.validate(c) ? c : COMMIT_CRON);

const build = (base: Omit<VaultCtx, 'posted' | 'noProof' | 'state' | 'evidence'>): VaultCtx => {
  const prev = cache.get(base.shop);
  const ctx: VaultCtx = { ...base, evidence: prev?.evidence ?? evidenceReads(base.shop), posted: prev?.posted ?? new Set(), noProof: prev?.noProof ?? new Set(), state: prev?.state ?? null };
  cache.set(base.shop, ctx);
  return ctx;
};

const defaultCtx = async (): Promise<VaultCtx> => {
  const company = await prismaQuery.company.findUniqueOrThrow({ where: { shopContractId: SHOP_CONTRACT_ID }, select: { id: true } });
  const publicKey = publicKeyOf(TESTER_PRIVATE_KEY);
  return build({
    companyId: company.id,
    shop: SHOP_CONTRACT_ID,
    isDefault: true,
    signerId: TESTER_ACCOUNT_ID,
    publicKey,
    ...signerFor(SHOP_CONTRACT_ID, TESTER_ACCOUNT_ID, TESTER_PRIVATE_KEY, publicKey, USDC_CONTRACT_ID),
    tokenId: USDC_CONTRACT_ID,
    decimals: TOKEN_DECIMALS,
    testPercent: TEST_PROBABILITY_PERCENT,
    commitCron: COMMIT_CRON,
    enabled: true,
  });
};

let warnedNoSeed = false;

/**
 * The default vault (env, always), every enabled company, and every company with open sealed slots, so disabling
 * testing or losing the key never strands a slot. Without TESTER_KEY_SEED only the default vault is served.
 */
/** Non-default companies to serve: enabled ones, and any with Prepared or Committed sealed slots. */
export const candidateCompanies = async () => {
  const open = await prismaQuery.sealedSlot.groupBy({ by: ['companyId'], where: { status: { in: ['Prepared', 'Committed'] } } });
  return prismaQuery.company.findMany({
    where: { shopContractId: { not: SHOP_CONTRACT_ID }, OR: [{ testerEnabled: true }, { id: { in: open.map((o) => o.companyId) } }] },
    select: { id: true, shopContractId: true, testerEnabled: true, testerEnabledAt: true, testerSignerId: true, testPercent: true, commitCron: true },
    orderBy: { shopContractId: 'asc' },
  });
};

export const loadContexts = async (): Promise<VaultCtx[]> => {
  const out = [await defaultCtx()];
  const companies = await candidateCompanies();
  if (companies.length && !TESTER_KEY_SEED) {
    if (!warnedNoSeed) log.warn('TESTER_KEY_SEED is not set: only the default vault is served', { skipped: companies.length });
    warnedNoSeed = true;
    return out;
  }
  const served = withinCapacity(
    companies.filter((c) => c.testerEnabled).map((c) => ({ shop: c.shopContractId, enabledAt: c.testerEnabledAt })),
    TESTER_MAX_VAULTS
  );
  for (const c of companies) {
    try {
      const status = await getStatus(c.shopContractId);
      const signerId = c.testerSignerId ?? status.owner_id;
      const key = testerKeyFor(TESTER_KEY_SEED!, NEAR.network, c.shopContractId);
      const publicKey = key.getPublicKey().toString();
      out.push(
        build({
          companyId: c.id,
          shop: c.shopContractId,
          isDefault: false,
          signerId,
          publicKey,
          ...signerFor(c.shopContractId, signerId, key.toString(), publicKey, status.token_id),
          tokenId: status.token_id,
          decimals: await decimalsOf(status.token_id),
          testPercent: c.testPercent,
          commitCron: validCron(c.commitCron),
          enabled: c.testerEnabled && served.has(c.shopContractId),
        })
      );
    } catch (error) {
      // one unreadable vault must not take the others down; its slots wait for the next reload or the keeper
      log.error('vault context failed', { shop: c.shopContractId, ...errFields(error) });
    }
  }
  return out;
};

let current: { at: number; list: Promise<VaultCtx[]> } | null = null;
const RELOAD_MS = 5 * 60_000;

/** Contexts, reloaded at most every 5 minutes; `fresh` forces a reload. */
export const contexts = (fresh = false): Promise<VaultCtx[]> => {
  if (!fresh && current && Date.now() - current.at < RELOAD_MS) return current.list;
  const list = loadContexts();
  current = { at: Date.now(), list };
  list.catch(() => (current = null));
  return list;
};

export const setState = async (ctx: VaultCtx, state: TesterState): Promise<void> => {
  ctx.state = state;
  await prismaQuery.company.updateMany({ where: { id: ctx.companyId }, data: { testerState: state, testerCheckedAt: new Date() } });
};

/** Generation attempts of non-default vaults in the last 24 h (TESTER_MAX_LURES_PER_DAY counts every paid call). */
export const attemptsToday = async (): Promise<number> => {
  const def = await prismaQuery.company.findUnique({ where: { shopContractId: SHOP_CONTRACT_ID }, select: { id: true } });
  return prismaQuery.generationAttempt.count({ where: { createdAt: { gte: new Date(Date.now() - DAY_MS) }, ...(def ? { companyId: { not: def.id } } : {}) } });
};

/**
 * Checks what the next job needs and records the state on the company. `forCommit` adds the commit checks.
 * The default vault is checked the same way, but its jobs never wait on the result (shop4 runs as before).
 */
export const preflight = async (ctx: VaultCtx, forCommit: boolean): Promise<TesterState> => {
  const status = await getStatus(ctx.shop);
  const { keys } = await rpc.viewAccessKeyList({ accountId: ctx.signerId, finalityQuery: { finality: 'final' } });
  const facts: PreflightFacts = {
    ownerId: status.owner_id,
    signerId: ctx.signerId,
    key: checkTesterKey(keys as unknown as OwnerKeyEntry[], ctx.publicKey, ctx.shop, TESTER_MIN_ALLOWANCE_YOCTO),
  };
  if (forCommit && !ctx.isDefault && facts.ownerId === facts.signerId && facts.key.ok) {
    const [policy, vendors, acct, open, attempts] = await Promise.all([
      getPolicy(ctx.shop),
      prismaQuery.vendor.count({ where: { companyId: ctx.companyId } }),
      rpc.viewAccount({ accountId: ctx.shop }),
      prismaQuery.testSlot.count({ where: { companyId: ctx.companyId, status: 'Committed' } }),
      attemptsToday(),
    ]);
    let policyOk = true;
    try {
      const ttlMs = Number(BigInt(policy.test_ttl) / 1_000_000n);
      assertRevealGrace(Number(BigInt(policy.reveal_grace) / 1_000_000n));
      const now = Date.now();
      const answerMs = Number(BigInt(policy.min_answer ?? '0') / 1_000_000n);
      policyOk = candidateTicks({ now: new Date(now), expiresAt: new Date(now + ttlMs), answerBy: new Date(now + ttlMs - answerMs), periodMinutes: RELEASE_TICK_MINUTES }).length > 0;
    } catch {
      policyOk = false;
    }
    facts.commit = {
      mode: status.mode,
      vendors,
      batchSize: policy.batch_size,
      maxBatchSize: TESTER_MAX_BATCH_SIZE,
      policyOk,
      headroomYocto: writeHeadroom(BigInt(acct.amount), acct.storage_usage, BigInt(policy.min_near_float), {
        openSlots: open,
        armedGasKey: status.mode === 'Armed' && (policy.key_nonces ?? 0) > 0,
        keyAllowanceYocto: BigInt(policy.key_allowance),
      }),
      withinCapacity: ctx.enabled,
      luresLeftToday: lureAllowance(false, policy.batch_size, policy.batch_size, attempts, TESTER_MAX_LURES_PER_DAY),
    };
  }
  const state = decidePreflight(facts);
  await setState(ctx, state);
  return state;
};

/**
 * Writes each registered company's tester public key: derived for non-default vaults, TESTER_PRIVATE_KEY's for the
 * default. This is how the API learns the keys without the seed; it also repairs a key someone else wrote.
 */
export const provisionKeys = async (): Promise<number> => {
  const rows = await prismaQuery.company.findMany({ select: { id: true, shopContractId: true, testerPublicKey: true } });
  let written = 0;
  for (const r of rows) {
    const isDefault = r.shopContractId === SHOP_CONTRACT_ID;
    if (!isDefault && !TESTER_KEY_SEED) continue;
    const pk = isDefault ? publicKeyOf(TESTER_PRIVATE_KEY) : testerKeyFor(TESTER_KEY_SEED!, NEAR.network, r.shopContractId).getPublicKey().toString();
    if (r.testerPublicKey === pk) continue;
    await prismaQuery.company.updateMany({ where: { id: r.id }, data: { testerPublicKey: pk } });
    log.info(r.testerPublicKey ? 'tester_key_mismatch_fixed' : 'tester_key_written', { shop: r.shopContractId, publicKey: pk });
    written++;
  }
  return written;
};
