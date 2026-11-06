import {
  AGENT_COMPANY_NAME,
  AGENT_E2EE,
  AGENT_LISTED_ONLY,
  AGENT_MODEL,
  AGENT_PRIVATE_KEY,
  AGENT_VAULT_ID,
  CALL_TGAS,
  FASTNEAR_API_KEY,
  INTENTS_CONTRACT_ID,
  MAX_ATTEMPTS,
  MAX_STEPS,
  NEAR_NETWORK,
  NEAR_RPC_URL,
  NEAR_TX_API_URL,
  NEARAI_API_KEY,
  NEARAI_BASE_URL,
  PAY_TGAS,
  PAY_INTENTS_TGAS,
  POLL_MS,
  TOKEN_DECIMALS,
  PRICE_IN_PER_MTOK,
  PRICE_OUT_PER_MTOK,
  DAILY_TOKEN_BUDGET,
  DAILY_COST_BUDGET_USD,
  USAGE_STATUS_MIN,
} from './src/config.ts';
import { advance, blocklist, getVendor, loadState, nextInvoice, saveState, whoami } from './src/inbox.ts';
import { createAgentLoop } from './src/loop.ts';
import { createNearAiClient } from './src/llm.ts';
import { createRunTool } from './src/tools.ts';
import { createVault } from './src/vault.ts';
import { closeTicks, syncAcks, type AckDeps } from './src/acks.ts';
import { createGetVendor } from './src/vendor.ts';
import { errMessage, log } from './src/log.ts';
import { runItem } from './src/item.ts';
import { createMeter, loadUsage } from './src/usage.ts';

let stopping = false;
process.once('SIGINT', () => (stopping = true));
process.once('SIGTERM', () => (stopping = true));

const vault = createVault({
  rpcUrl: NEAR_RPC_URL,
  vaultId: AGENT_VAULT_ID,
  privateKey: AGENT_PRIVATE_KEY,
  txApiUrl: NEAR_TX_API_URL,
  fastnearApiKey: FASTNEAR_API_KEY,
  payTgas: PAY_TGAS,
  payIntentsTgas: PAY_INTENTS_TGAS,
  callTgas: CALL_TGAS,
  listedOnly: AGENT_LISTED_ONLY,
});

// A per-vault inbox token serves one vault (v2/37 section 4): refuse to run against another vault's inbox.
// an unreachable API is not a mismatch: the loop retries it anyway
const inboxShop = await whoami().catch((e: unknown) => {
  log.warn('inbox whoami failed; vault match not checked', { error: e instanceof Error ? e.message : String(e) });
  return null;
});
if (inboxShop === null) log.warn('inbox vault not confirmed (API unreachable or without /inbox/whoami)');
else if (inboxShop.shop !== AGENT_VAULT_ID) {
  log.error('INBOX_TOKEN serves another vault', { inboxVault: inboxShop.shop, agentVault: AGENT_VAULT_ID });
  process.exit(1);
}

const status = await vault.getStatus();
// Intents has no testnet; only offer the rail when the vault itself has it enabled.
const intentsEnabled = !!INTENTS_CONTRACT_ID && status.intents_id === INTENTS_CONTRACT_ID;
if (INTENTS_CONTRACT_ID && !intentsEnabled) log.warn('INTENTS_CONTRACT_ID set but the vault has a different or no intents_id; rail disabled');

const runTool = createRunTool({
  ...vault,
  // the vault, its token and Intents contract are never payees
  reservedAccounts: [AGENT_VAULT_ID, status.token_id, ...(status.intents_id ? [status.intents_id] : [])],
  getVendor: createGetVendor({ vendorRecord: getVendor, approvedPayees: vault.getApprovedPayees, nowMs: Date.now }),
  // AG-07: the payee's on-chain label must name the invoice's vendor before a pay
  vendorName: async (id) => {
    const r = (await getVendor(id)) as { legalName?: unknown } | null;
    return typeof r?.legalName === 'string' ? r.legalName : null;
  },
  blocklist, // shared payee blocklist through the inbox API; a failed lookup is a warn
  intentsEnabled,
  tokenDecimals: TOKEN_DECIMALS,
});
const myKey = vault.publicKey();
const state = await loadState();
// rolling 24 h NEAR AI usage, kept in the state file so a restart cannot reset the budget
const usage = loadUsage(state.inference, Date.now());
state.inference = usage;
const meter = createMeter({
  window: usage,
  prices: { inPerMTok: PRICE_IN_PER_MTOK, outPerMTok: PRICE_OUT_PER_MTOK },
  budget: { tokens: DAILY_TOKEN_BUDGET, costUsd: DAILY_COST_BUDGET_USD },
  nowMs: Date.now,
  save: () => saveState(state),
  log,
  statusEveryMs: USAGE_STATUS_MIN * 60_000,
});
const processInvoice = createAgentLoop({
  ...createNearAiClient({ apiKey: NEARAI_API_KEY, baseUrl: NEARAI_BASE_URL, e2ee: AGENT_E2EE }),
  model: AGENT_MODEL,
  maxSteps: MAX_STEPS,
  requireProviderTee: true,
  meter,
});
log.info('started', { network: NEAR_NETWORK, vault: AGENT_VAULT_ID, model: AGENT_MODEL, e2ee: AGENT_E2EE, mode: status.mode, keyArmed: status.agent_key === myKey, intentsEnabled, listedOnly: AGENT_LISTED_ONLY, inference24h: meter.totals() });

const ackDeps: AckDeps = {
  getRelease: vault.getRelease,
  ack: vault.ack,
  canSign: async () => {
    const s = await vault.getStatus();
    return (s.mode === 'Armed' || s.mode === 'Demoted') && s.agent_key === myKey;
  },
  save: () => saveState(state),
  nowMs: Date.now,
  log,
};

while (!stopping) {
  try {
    meter.maybeLogStatus();
    await syncAcks(state.acks, ackDeps); // v2/32: one signed root per release tick
    const item = await nextInvoice(state.cursor);
    if (closeTicks(state.acks, item?.receivedAt ?? null, Date.now())) await saveState(state);
    if (!item) {
      await Bun.sleep(POLL_MS);
      continue;
    }
    const s = await vault.getStatus();
    // Unarmed, Frozen, or another key armed: hold the cursor and wait for the owner and vendor.
    if ((s.mode !== 'Armed' && s.mode !== 'Demoted') || s.agent_key !== myKey) {
      log.info('waiting for an armed key', { mode: s.mode, keyArmed: s.agent_key === myKey });
      await Bun.sleep(60_000);
      continue;
    }
    if (await vault.getDecision(item.id)) {
      log.info('already decided on chain', { invoice: item.id });
      await advance(state, item);
      continue;
    }
    const outcome = await runItem({
      item,
      state,
      process: () => processInvoice(item, s.mode, AGENT_COMPANY_NAME, runTool, intentsEnabled),
      advance,
      saveState,
      maxAttempts: MAX_ATTEMPTS,
      log,
      fields: { mode: s.mode, model: AGENT_MODEL },
    });
    // budget: the cursor holds on this invoice; retried each poll until the window frees
    if (outcome === 'retry' || outcome === 'budget') await Bun.sleep(POLL_MS);
  } catch (error) {
    log.error('loop error', { error: errMessage(error) });
    await Bun.sleep(POLL_MS);
  }
}
log.info('stopped');
