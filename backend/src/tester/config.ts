// Tester process config (.env.tester). The API never imports this.
import { nearConfigFromEnv } from '../config/network.ts';
import { isValidAccountId } from '../utils/ids.ts';
import { DEFAULT_GENERATOR_MODELS } from './generator.ts';

const fatal = (msg: string): never => {
  process.stderr.write(JSON.stringify({ level: 'error', time: new Date().toISOString(), component: 'tester-config', msg }) + '\n');
  process.exit(1);
};

const req = (k: string): string => process.env[k] || fatal(`Missing ${k}`);
const account = (k: string, v: string): string => (isValidAccountId(v) ? v : fatal(`${k} is not a valid account id`));
const num = (k: string, d: number): number => {
  const v = Number(process.env[k] ?? d);
  return Number.isFinite(v) ? v : fatal(`${k} must be a number`);
};

req('DATABASE_URL');
export const NEAR = nearConfigFromEnv();
export const SHOP_CONTRACT_ID = account('SHOP_CONTRACT_ID', req('SHOP_CONTRACT_ID'));
export const TESTER_ACCOUNT_ID = account('TESTER_ACCOUNT_ID', req('TESTER_ACCOUNT_ID')); // the vault owner
export const TESTER_PRIVATE_KEY = req('TESTER_PRIVATE_KEY'); // FC key on the owner: commit_batch, reveal, release, prove_delivery
// Token the vault pays in; cross-checked against get_status().token_id at startup.
export const USDC_CONTRACT_ID = account('USDC_CONTRACT_ID', req('USDC_CONTRACT_ID'));
export const TOKEN_DECIMALS = num('TOKEN_DECIMALS', 6);

const sealHex = req('TEST_SEAL_KEY');
if (!/^[0-9a-fA-F]{64}$/.test(sealHex)) fatal('TEST_SEAL_KEY must be 64 hex chars (32 bytes)');
export const TEST_SEAL_KEY = Buffer.from(sealHex, 'hex');

// NEAR AI Cloud
export const NEARAI_BASE_URL = process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1';
// Optional: without it (or on Bun < 1.4.4) the tester never generates tests; it still recovers and reveals.
export const NEARAI_API_KEY_TESTER = process.env.NEARAI_API_KEY_TESTER || '';
// Deadline per NEAR AI call (request, body and verification); a hung generation call otherwise blocks the commit worker.
// 900 s: a reasoning draft measured 6k to 14k reasoning tokens at about 46 tokens/s on 2026-11-11.
export const NEARAI_TIMEOUT_MS = Number(process.env.NEARAI_TIMEOUT_S || 900) * 1000;
if (!Number.isInteger(NEARAI_TIMEOUT_MS) || NEARAI_TIMEOUT_MS < 1_000) throw new Error('NEARAI_TIMEOUT_S must be an integer of at least 1');
// on: model default reasoning (what B1 measured); off: enable_thinking=false, about 20x faster per draft.
export const GENERATOR_THINKING = (process.env.GENERATOR_THINKING || 'on') as 'on' | 'off';
if (GENERATOR_THINKING !== 'on' && GENERATOR_THINKING !== 'off') throw new Error('GENERATOR_THINKING must be on or off');
const bunAtLeast = (min: string): boolean => {
  const [a, b, c] = (typeof Bun === 'undefined' ? '0.0.0' : Bun.version).split('.').map(Number);
  const [x, y, z] = min.split('.').map(Number);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
};
// @nearai/inference-sdk/node needs Bun >= 1.4.4 for its TLS binding (17a §5)
export const GENERATION_BLOCKER: string | null = !NEARAI_API_KEY_TESTER
  ? 'NEARAI_API_KEY_TESTER is not set'
  : !bunAtLeast('1.4.4')
    ? `Bun ${typeof Bun === 'undefined' ? 'unknown' : Bun.version} < 1.4.4 (inference SDK TLS binding)`
    : null;
// B12: GENERATOR_MODELS overrides the whole ordered list; default tries the RED abliterated model first.
export const GENERATOR_MODELS: string[] = (process.env.GENERATOR_MODELS ? process.env.GENERATOR_MODELS.split(',') : DEFAULT_GENERATOR_MODELS)
  .map((s) => s.trim())
  .filter(Boolean);

// Batches and delivery
export const COMMIT_CRON = process.env.TESTER_COMMIT_CRON || '0 0 * * *'; // UTC
export const TEST_PROBABILITY_PERCENT = num('TEST_PROBABILITY_PERCENT', 50); // else the slot is void
// Lure amounts come from the vendor's real amounts (SS-B01); there is deliberately no constant amount setting.
for (const legacy of ['TEST_AMOUNT', 'GENERATOR_MODEL', 'GENERATOR_FALLBACK_MODELS', 'DELIVERY_SLOT_MINUTES']) {
  if (process.env[legacy]) {
    process.stderr.write(JSON.stringify({ level: 'warn', time: new Date().toISOString(), component: 'tester-config', msg: `${legacy} is ignored in v2 (see .env.tester.example)` }) + '\n');
  }
}
export const TEST_ETH_PAYEE_PERCENT = num('TEST_ETH_PAYEE_PERCENT', 50); // share of 0x eth-implicit payees (B2)
// Release ticks (B3): must equal the API's RELEASE_TICK_MINUTES.
export const RELEASE_TICK_MINUTES = num('RELEASE_TICK_MINUTES', 120);
// Hours used only until real invoices exist to weight test ticks by.
export const DELIVERY_START_HOUR_UTC = num('TEST_DELIVERY_START_HOUR_UTC', 8);
export const DELIVERY_END_HOUR_UTC = num('TEST_DELIVERY_END_HOUR_UTC', 18);
export const REAL_HISTORY_DAYS = num('REAL_HISTORY_DAYS', 30);
export const COMMIT_TGAS = BigInt(num('TESTER_COMMIT_TGAS', 50));
export const REVEAL_TGAS = BigInt(num('TESTER_REVEAL_TGAS', 100));

// Sweep (optional): a low-balance funder with a full-access key creates failed-test payees and pulls tokens back.
// Sweep needs both; a half-configured sweep is disabled with a warning rather than blocking commits and reveals.
const sweepComplete = !!process.env.SWEEP_FUNDER_ID && !!process.env.SWEEP_FUNDER_KEY;
if (!sweepComplete && (process.env.SWEEP_FUNDER_ID || process.env.SWEEP_FUNDER_KEY)) {
  process.stderr.write(JSON.stringify({ level: 'warn', time: new Date().toISOString(), component: 'tester-config', msg: 'sweep disabled: set both SWEEP_FUNDER_ID and SWEEP_FUNDER_KEY' }) + '\n');
}
export const SWEEP_FUNDER_ID = sweepComplete ? account('SWEEP_FUNDER_ID', process.env.SWEEP_FUNDER_ID!) : '';
export const SWEEP_FUNDER_KEY = sweepComplete ? process.env.SWEEP_FUNDER_KEY! : '';
export const SWEEP_FUND_NEAR = process.env.SWEEP_FUND_NEAR || '0.05'; // covers account storage plus gas at 0.001 NEAR/Tgas
if (!/^\d+(\.\d{1,24})?$/.test(SWEEP_FUND_NEAR)) fatal('SWEEP_FUND_NEAR must be a decimal NEAR amount');

// Multi-vault (v2/37). Unset seed: only the default vault (SHOP_CONTRACT_ID) is served, exactly as before.
const seedHex = process.env.TESTER_KEY_SEED || '';
if (seedHex && !/^[0-9a-fA-F]{64}$/.test(seedHex)) fatal('TESTER_KEY_SEED must be 64 hex chars (32 bytes)');
// never logged; derives one FC key per vault (src/tester/keys.ts)
export const TESTER_KEY_SEED: Buffer | null = seedHex ? Buffer.from(seedHex, 'hex') : null;
const bounded = (k: string, d: number, min: number, max: number): number => {
  const v = num(k, d);
  return Number.isInteger(v) && v >= min && v <= max ? v : fatal(`${k} must be an integer from ${min} to ${max}`);
};
// The first three must equal the API's values (.env), which checks them at enable time.
export const TESTER_MAX_VAULTS = bounded('TESTER_MAX_VAULTS', 10, 0, 1000); // enabled non-default vaults served
export const TESTER_MAX_BATCH_SIZE = bounded('TESTER_MAX_BATCH_SIZE', 10, 1, 100);
const minAllowance = process.env.TESTER_MIN_ALLOWANCE_YOCTO || '100000000000000000000000'; // 0.1 NEAR
if (!/^\d{1,30}$/.test(minAllowance)) fatal('TESTER_MIN_ALLOWANCE_YOCTO must be a yocto integer');
export const TESTER_MIN_ALLOWANCE_YOCTO = BigInt(minAllowance);
// Non-default vaults only: NEAR AI spend from free self-serve vaults
export const TESTER_MAX_LURES_PER_BATCH = bounded('TESTER_MAX_LURES_PER_BATCH', 3, 0, 100);
export const TESTER_MAX_LURES_PER_DAY = bounded('TESTER_MAX_LURES_PER_DAY', 30, 0, 10_000);
