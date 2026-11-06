import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { errMessage, log, logToStderr } from './src/log.ts';
import { acquireStateLock, assertNoNativeAgent, mcpConfig } from './src/mcp/config.ts';
import { reserveStdout } from './src/mcp/stdout.ts';
import { createMcpServer } from './src/mcp/server.ts';
import { createSession } from './src/mcp/session.ts';
import { createInbox } from './src/inboxClient.ts';
import { createRunTool } from './src/tools.ts';
import { createVault } from './src/vault.ts';
import { createGetVendor } from './src/vendor.ts';
import pkg from './package.json' with { type: 'json' };

// Bring your own agent: the inbox and vault tools of index.ts over MCP stdio, for any MCP client. No NEAR AI here.
logToStderr();
const wire = reserveStdout(); // only the transport writes to stdout

const cfg = mcpConfig();
assertNoNativeAgent(cfg.AGENT_STATE_FILE, Date.now(), cfg.MCP_ALLOW_CONCURRENT);
const releaseLock = acquireStateLock(cfg.MCP_STATE_PATH);
process.once('exit', releaseLock);
const vault = createVault({
  rpcUrl: cfg.NEAR_RPC_URL,
  vaultId: cfg.AGENT_VAULT_ID,
  privateKey: cfg.AGENT_PRIVATE_KEY,
  txApiUrl: cfg.NEAR_TX_API_URL,
  fastnearApiKey: cfg.FASTNEAR_API_KEY,
  payTgas: cfg.PAY_TGAS,
  payIntentsTgas: cfg.PAY_INTENTS_TGAS,
  callTgas: cfg.CALL_TGAS,
  listedOnly: cfg.AGENT_LISTED_ONLY,
});
const inbox = createInbox({ url: cfg.INBOX_URL, token: cfg.INBOX_TOKEN, stateFile: cfg.MCP_STATE_PATH });

const status = await vault.getStatus();
const intentsEnabled = !!cfg.INTENTS_CONTRACT_ID && status.intents_id === cfg.INTENTS_CONTRACT_ID;
if (cfg.INTENTS_CONTRACT_ID && !intentsEnabled) log.warn('INTENTS_CONTRACT_ID set but the vault has a different or no intents_id; rail disabled');

// same wiring as index.ts, so validation, preflight and the sign cap are the native agent's
const runTool = createRunTool({
  ...vault,
  reservedAccounts: [cfg.AGENT_VAULT_ID, status.token_id, ...(status.intents_id ? [status.intents_id] : [])],
  getVendor: createGetVendor({ vendorRecord: inbox.getVendor, approvedPayees: vault.getApprovedPayees, nowMs: Date.now }),
  vendorName: async (id) => {
    const r = (await inbox.getVendor(id)) as { legalName?: unknown } | null;
    return typeof r?.legalName === 'string' ? r.legalName : null;
  },
  blocklist: inbox.blocklist,
  intentsEnabled,
  tokenDecimals: cfg.TOKEN_DECIMALS,
  preflightMode: cfg.MCP_PREFLIGHT,
});
if (cfg.MCP_PREFLIGHT === 'advisory') {
  log.warn('ADVISORY PREFLIGHT: pay and propose sign despite warn or block verdicts; only the vault contract, the sign cap and input checks stop a payment. For benchmarking a model, never for production', { vault: cfg.AGENT_VAULT_ID, listedOnly: cfg.AGENT_LISTED_ONLY });
}

const session = await createSession({
  vault,
  inbox,
  runTool,
  vaultId: cfg.AGENT_VAULT_ID,
  company: cfg.AGENT_COMPANY_NAME,
  intentsEnabled,
  tokenDecimals: cfg.TOKEN_DECIMALS,
  listedOnly: cfg.AGENT_LISTED_ONLY,
  preflightMode: cfg.MCP_PREFLIGHT,
  maxResultBytes: cfg.MCP_MAX_RESULT_BYTES,
  decisionTimeoutMs: cfg.MCP_DECISION_TIMEOUT_S * 1000,
  maxToolCallsPerInvoice: cfg.MCP_MAX_TOOL_CALLS_PER_INVOICE,
  nowMs: Date.now,
  log,
});
const stopAcks = session.startAckLoop(cfg.POLL_MS);
const handle = serveStdio(() => createMcpServer(session, { intentsEnabled, preflightMode: cfg.MCP_PREFLIGHT, version: pkg.version }), {
  transport: new StdioServerTransport(process.stdin, wire),
  onerror: (e) => log.error('mcp transport error', { error: errMessage(e) }),
});
log.info('mcp server started', { network: cfg.NEAR_NETWORK, vault: cfg.AGENT_VAULT_ID, mode: status.mode, keyArmed: status.agent_key === vault.publicKey(), intentsEnabled, listedOnly: cfg.AGENT_LISTED_ONLY, preflight: cfg.MCP_PREFLIGHT, statePath: cfg.MCP_STATE_PATH });

let stopping = false;
const shutdown = async (why: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  stopAcks();
  await session.idle(); // an in-flight pay or ack finishes and its state is saved
  await handle.close().catch(() => undefined);
  log.info('mcp server stopped', { why });
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
// the client closing stdin ends the session; the ack timer would otherwise keep the process alive
process.stdin.once('end', () => void shutdown('stdin closed'));
process.stdin.once('close', () => void shutdown('stdin closed'));
