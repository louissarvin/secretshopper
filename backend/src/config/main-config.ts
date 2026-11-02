/**
 * Centralized configuration for the API process (index.ts).
 * The tester process has its own config in src/tester/config.ts.
 */
import { resolve } from 'node:path';
import { baseDecode } from 'near-api-js';
import { nearConfigFromEnv } from './network.ts';
import { isValidAccountId } from '../utils/ids.ts';
import { parseWebhookUrls } from '../lib/alerts/webhook.ts';

const requiredEnvVars: string[] = ['DATABASE_URL', 'JWT_SECRET', 'SHOP_CONTRACT_ID', 'INBOX_TOKEN_HASH'];

const fatal = (msg: string): never => {
  process.stderr.write(JSON.stringify({ level: 'error', time: new Date().toISOString(), component: 'config', msg }) + '\n');
  process.exit(1);
};

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) fatal(`Missing required environment variable: ${envVar}`);
}

// App
export const APP_PORT: number = Number(process.env.APP_PORT) || 3700;
// Loopback by default; containers set APP_HOST=0.0.0.0 explicitly.
export const APP_HOST: string = process.env.APP_HOST || '127.0.0.1';
export const NODE_ENV: string = process.env.NODE_ENV || 'development';
export const IS_DEV: boolean = NODE_ENV === 'development';
export const IS_PROD: boolean = NODE_ENV === 'production';
export const TRUST_PROXY: boolean = process.env.TRUST_PROXY === 'true';

// Database
export const DATABASE_URL: string = process.env.DATABASE_URL as string;

// Auth (JWT after NEP-413)
export const JWT_SECRET: string = process.env.JWT_SECRET as string;
export const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '12h';
if (JWT_SECRET.length < 32) fatal('JWT_SECRET must be at least 32 characters');
export const AUTH_RECIPIENT: string = process.env.AUTH_RECIPIENT || 'localhost';
// SS-B06: in production the NEP-413 recipient must be the real web host, or a relay site can collect sign-ins.
if (IS_PROD && /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(AUTH_RECIPIENT)) {
  fatal('AUTH_RECIPIENT must be the web host in production, not localhost');
}
export const AUTH_MESSAGE: string = process.env.AUTH_MESSAGE || 'Sign in to Secret Shopper';
export const AUTH_CHALLENGE_TTL_MS: number = 5 * 60 * 1000;

// CORS: explicit allowlist, never '*'
export const CORS_ORIGINS: string[] = (process.env.CORS_ORIGINS || 'http://localhost:3200')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (CORS_ORIGINS.includes('*')) fatal('CORS_ORIGINS must list origins explicitly, "*" is not allowed');

// NEAR
export const NEAR = nearConfigFromEnv();
export const SHOP_CONTRACT_ID: string = process.env.SHOP_CONTRACT_ID as string;
if (!isValidAccountId(SHOP_CONTRACT_ID)) fatal('SHOP_CONTRACT_ID is not a valid account id');
// Owner, vendor, token and intents ids are read from the contract's get_status, not configured here.

// 1Click (payout quote preview). Optional partner JWT; without it quotes carry the unauthenticated fee.
export const ONECLICK_JWT: string = process.env.ONECLICK_JWT || '';
export const ONECLICK_API_URL: string = process.env.ONECLICK_API_URL || '';

// Self-serve vaults (/public/vault-*): the published global contract (contract 2.3.0) and the default token per network.
const VAULT_DEFAULTS = {
  testnet: { codeHash: '5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs', tokenId: 'tusdc.ss-owner-e9c3db.testnet' },
  mainnet: { codeHash: '', tokenId: '' },
} as const;
export const VAULT_CODE_HASH: string = process.env.VAULT_CODE_HASH ?? VAULT_DEFAULTS[NEAR.network].codeHash;
if (VAULT_CODE_HASH && !(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(VAULT_CODE_HASH) && baseDecode(VAULT_CODE_HASH).length === 32)) fatal('VAULT_CODE_HASH must be a base58 sha256 code hash');
export const VAULT_DEFAULT_TOKEN_ID: string = process.env.VAULT_DEFAULT_TOKEN_ID ?? VAULT_DEFAULTS[NEAR.network].tokenId;
if (VAULT_DEFAULT_TOKEN_ID && !isValidAccountId(VAULT_DEFAULT_TOKEN_ID)) fatal('VAULT_DEFAULT_TOKEN_ID is not a valid account id');
export const VAULT_PLAN_MAINNET: boolean = process.env.VAULT_PLAN_MAINNET === 'true';

// Inbox: sha256 hex of the agent's bearer token
export const INBOX_TOKEN_HASH: string = (process.env.INBOX_TOKEN_HASH as string).toLowerCase();
if (!/^[0-9a-f]{64}$/.test(INBOX_TOKEN_HASH)) fatal('INBOX_TOKEN_HASH must be 64 hex chars (sha256 of the token)');

// Indexer
export const EVENT_STANDARD = 'secret_shopper';
export const INDEXER_SOURCE: 'fastnear' | 'neardata' = process.env.INDEXER_SOURCE === 'neardata' ? 'neardata' : 'fastnear';
export const INDEXER_START_HEIGHT: number = Number(process.env.INDEXER_START_HEIGHT || 0);
export const INDEXER_INTERVAL: string = '*/10 * * * * *';
export const INDEXER_FINALITY_LAG: number = Number(process.env.INDEXER_FINALITY_LAG || 250); // blocks
export const INDEXER_MAX_SPAN: number = 20_000; // blocks per FastNEAR query; the API pages by resume_token, so wide is cheap
export const INDEXER_SPANS_PER_TICK: number = 10; // up to 200k blocks (about 2 days of testnet) per tick when behind
export const INDEXER_BATCH_BLOCKS: number = Number(process.env.INDEXER_BATCH_BLOCKS) || 50; // neardata fallback
export const PROJECTOR_INTERVAL: string = '*/10 * * * * *';

// Release ticks (SS-B02): real and test invoices become visible only at these UTC ticks; the tester uses the same value.
export const RELEASE_TICK_MINUTES: number = Number(process.env.RELEASE_TICK_MINUTES || 120);

// Committed model measurements for GET /public/model-runs, in backend/data/ by default.
export const MODEL_RUNS_DIR: string = resolve(process.env.MODEL_RUNS_DIR || resolve(import.meta.dir, '../../data/model-runs'));
export const B1_SUMMARY_PATH: string = resolve(process.env.B1_SUMMARY_PATH || resolve(import.meta.dir, '../../data/b1-summary.json'));
// Committed `bun run verify --record` result (scripts/verify-all.ts) for GET /public/verify-report.
export const VERIFY_REPORT_PATH: string = resolve(process.env.VERIFY_REPORT_PATH || resolve(import.meta.dir, '../../data/verify-report.json'));

// Alerts: webhook POSTs for events the owner must know. No URLs means the worker is off.
const boundedInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fatal(`${name} must be an integer from ${min} to ${max}`);
};
export const ALERT_WEBHOOK_URLS: string[] = (() => {
  try {
    return parseWebhookUrls(process.env.ALERT_WEBHOOK_URLS || '');
  } catch (error) {
    return fatal(`ALERT_WEBHOOK_URLS: ${(error as Error).message}`);
  }
})();
export const ALERT_WEBHOOK_SECRET: string = process.env.ALERT_WEBHOOK_SECRET || '';
if (ALERT_WEBHOOK_SECRET && ALERT_WEBHOOK_SECRET.length < 32) fatal('ALERT_WEBHOOK_SECRET must be at least 32 characters');
export const ALERT_POLL_SECONDS: number = boundedInt('ALERT_POLL_SECONDS', 15, 5, 3600);
export const ALERT_TIMEOUT_MS: number = boundedInt('ALERT_TIMEOUT_MS', 5000, 500, 30_000);
// Health checks (reveal_overdue, tester_stalled, gas_key_overfunded) run with or without webhooks: four RPC reads per run.
export const ALERT_HEALTH_SECONDS: number = boundedInt('ALERT_HEALTH_SECONDS', 60, 15, 3600);

// Multi-vault (v2/37). TESTER_MAX_VAULTS, TESTER_MAX_BATCH_SIZE and TESTER_MIN_ALLOWANCE_YOCTO must equal the tester's.
const boundedYocto = (name: string, fallback: bigint, min: bigint, max: bigint): bigint => {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d{1,30}$/.test(raw) || BigInt(raw) < min || BigInt(raw) > max) return fatal(`${name} must be a yocto amount from ${min} to ${max}`);
  return BigInt(raw);
};
const YOCTO = 10n ** 24n;
export const MAX_COMPANIES_PER_USER: number = boundedInt('MAX_COMPANIES_PER_USER', 5, 1, 100);
export const TESTER_MAX_VAULTS: number = boundedInt('TESTER_MAX_VAULTS', 10, 0, 1000);
export const TESTER_MAX_BATCH_SIZE: number = boundedInt('TESTER_MAX_BATCH_SIZE', 10, 1, 100);
export const TESTER_ALLOWANCE_YOCTO: bigint = boundedYocto('TESTER_ALLOWANCE_YOCTO', YOCTO, YOCTO / 100n, 100n * YOCTO);
export const TESTER_MIN_ALLOWANCE_YOCTO: bigint = boundedYocto('TESTER_MIN_ALLOWANCE_YOCTO', YOCTO / 10n, 1n, 100n * YOCTO);
export const INDEXER_VAULTS_PER_TICK: number = boundedInt('INDEXER_VAULTS_PER_TICK', 4, 0, 100);
export const INDEXER_SPANS_PER_TICK_OTHER: number = boundedInt('INDEXER_SPANS_PER_TICK_OTHER', 2, 1, 10);
// Agents count blocklist entries only from their own vault and these (ADR-6)
export const BLOCKLIST_TRUSTED_VAULTS: string[] = (process.env.BLOCKLIST_TRUSTED_VAULTS ?? SHOP_CONTRACT_ID)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (isValidAccountId(s) ? s : fatal(`BLOCKLIST_TRUSTED_VAULTS: ${s} is not a valid account id`)));

// Error log
export const ERROR_LOG_MAX_RECORDS: number = 10000;
export const ERROR_LOG_CLEANUP_INTERVAL: string = '0 * * * *'; // hourly

export default {
  APP_PORT,
  APP_HOST,
  NODE_ENV,
  IS_DEV,
  IS_PROD,
  DATABASE_URL,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
};
