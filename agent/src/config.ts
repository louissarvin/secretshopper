// Agent (vendor process) config. Reads only AGENT_* and network values; it has no database access by design.
import { chainConfig, httpsUrl, int, num, req } from './env.ts';

const c = chainConfig();

export const NEAR_NETWORK = c.NEAR_NETWORK;
export const AGENT_VAULT_ID = c.AGENT_VAULT_ID;
export const AGENT_PRIVATE_KEY = c.AGENT_PRIVATE_KEY;
export const AGENT_COMPANY_NAME = c.AGENT_COMPANY_NAME;
export const NEAR_RPC_URL = c.NEAR_RPC_URL;
export const NEAR_TX_API_URL = c.NEAR_TX_API_URL;
export const FASTNEAR_API_KEY = c.FASTNEAR_API_KEY;
export const INTENTS_CONTRACT_ID = c.INTENTS_CONTRACT_ID;
export const TOKEN_DECIMALS = c.TOKEN_DECIMALS;
export const AGENT_LISTED_ONLY = c.AGENT_LISTED_ONLY;

export const INBOX_URL = c.INBOX_URL;
export const INBOX_TOKEN = c.INBOX_TOKEN;
export const STATE_FILE = process.env.AGENT_STATE_FILE || './state.json';
export const POLL_MS = c.POLL_MS;

export const NEARAI_BASE_URL = httpsUrl('NEARAI_BASE_URL', process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1');
export const NEARAI_API_KEY = req('NEARAI_API_KEY_AGENT');
export const AGENT_MODEL = process.env.AGENT_MODEL || 'z-ai/glm-5.3-flash';
// Field-level E2EE to the attested model (tools and tool calls included). Either way the model must be TEE-attested.
export const AGENT_E2EE = (process.env.AGENT_E2EE ?? 'true').toLowerCase() !== 'false';
export const MAX_STEPS = 6;
export const MAX_ATTEMPTS = 3; // LLM/API failures per invoice before leaving it unanswered
export const PAY_TGAS = c.PAY_TGAS;
export const PAY_INTENTS_TGAS = c.PAY_INTENTS_TGAS;
export const CALL_TGAS = c.CALL_TGAS;

// Inference budget (src/usage.ts). Prices are USD per million tokens, from GET /v1/model/list; 0 = unknown.
export const PRICE_IN_PER_MTOK = num('AGENT_PRICE_IN_PER_MTOK', 0, 0, 1000);
export const PRICE_OUT_PER_MTOK = num('AGENT_PRICE_OUT_PER_MTOK', 0, 0, 1000);
export const DAILY_TOKEN_BUDGET = int('AGENT_DAILY_TOKEN_BUDGET', 0, 0, 1_000_000_000);
export const DAILY_COST_BUDGET_USD = num('AGENT_DAILY_COST_BUDGET_USD', 0, 0, 1_000_000);
// a cost budget with no prices would count every call as free and never stop
if (DAILY_COST_BUDGET_USD > 0 && PRICE_IN_PER_MTOK === 0 && PRICE_OUT_PER_MTOK === 0) throw new Error('AGENT_DAILY_COST_BUDGET_USD needs AGENT_PRICE_IN_PER_MTOK or AGENT_PRICE_OUT_PER_MTOK');
export const USAGE_STATUS_MIN = int('AGENT_USAGE_STATUS_MIN', 60, 1, 1440);
