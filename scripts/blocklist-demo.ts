/**
 * Shared blocklist end to end on testnet. Signs no transaction (the owner sign-in is a NEP-413 message).
 *   1. Checks the evidence on chain with the backend's own verifier: the reveal tx must hold a Failed test_revealed
 *      naming the payee, emitted by the vault.
 *   2. Signs in as the vault owner and reports the payee with POST /blocklist (idempotent: a second run gets 200).
 *   3. Reads GET /public/blocklist/:accountId.
 *   4. Runs the agent's real tool path (agent/src/tools.ts createRunTool, agent/src/preflight.ts) on a pay or propose
 *      to that payee, with live vault reads and the agent's blocklist lookup. Signing deps throw, so nothing is sent.
 * Writes the transcript to scripts/out/blocklist-<vault>-<date>.log. Exits 0 only if the verdict is block with `blocklisted`.
 *
 * Usage: bun --env-file=../agent/.env blocklist-demo.ts [payee] [evidenceTx]
 * Env: NEAR_NETWORK (testnet), API_URL (default http://localhost:3700). Optional INBOX_URL and INBOX_TOKEN (the agent's,
 *   from agent/.env) for the agent's own lookup; without them the public route stands in, and the log says so.
 * Owner key: ~/.near-credentials/<network>/<owner>.json (never argv).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { NEAR, txUrl } from './lib/net.ts';
import { api, API_URL, signIn } from './lib/owner.ts';
import { loadLegacyKey } from './lib/creds.ts';
import { verifyEvidence } from '../backend/src/lib/blocklist/evidence.ts';
import { evidenceReads } from '../backend/src/lib/blocklist/chainReads.ts';
import { createVault } from '../agent/src/vault.ts';
import { createInbox } from '../agent/src/inboxClient.ts';
import { createRunTool } from '../agent/src/tools.ts';
import type { BlocklistFacts } from '../agent/src/preflight.ts';

const PAYEE = process.argv[2] ?? '3c23855018f7bc402b49e8b8d2f883f81c33b7434e3f660ca3f9277f5ee31ac6'; // shop4 slot 5 lure payee
const EVIDENCE = process.argv[3] ?? 'AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az'; // shop4 slot 5 reveal, Failed
if (NEAR.network !== 'testnet') throw new Error('blocklist-demo runs on testnet only');

const lines: string[] = [];
const out = (s = '') => {
  console.log(s);
  lines.push(s);
};

const config = await api<{ shop: string; owner: string }>('GET', '/public/config');
if (!config.body.success) throw new Error(`/public/config ${config.status}`);
const { shop, owner } = config.body.data;
out(`Shared blocklist demo, ${new Date().toISOString()}`);
out(`network ${NEAR.network}, API ${API_URL}, vault ${shop}, owner ${owner}`);
out(`payee    ${PAYEE}`);
out(`evidence ${EVIDENCE} (${txUrl(EVIDENCE)})`);

out('\n1. Evidence on chain (backend verifier, FastNEAR tx API and the vault views)');
const reads = evidenceReads(shop);
for (const e of (await reads.txVaultEvents(EVIDENCE)) ?? []) out(`   ${e.event} ${JSON.stringify(e.data)}`);
const verdict = await verifyEvidence(PAYEE, EVIDENCE, reads);
out(`   verdict ${JSON.stringify(verdict)}`);
if (!verdict.ok) throw new Error(`evidence rejected: ${verdict.reason}`);

out('\n2. Owner report: POST /blocklist (NEP-413 sign-in, no transaction)');
const token = await signIn(owner, loadLegacyKey(NEAR.network, owner));
const reason = `Lure payee of test slot ${verdict.slotId} on ${shop}: paid by the agent, revealed Failed.`;
const report = await api<{ created: boolean; entry: unknown }>('POST', '/blocklist', { accountId: PAYEE, reason, evidenceTx: EVIDENCE }, token);
out(`   HTTP ${report.status} ${JSON.stringify(report.body.data ?? report.body.error)}`);
if (report.status !== 201 && report.status !== 200) throw new Error('report refused');

out('\n3. Public lookup: GET /public/blocklist/:accountId');
const pub = await api<{ listed: boolean; count: number; entries: { evidenceTx: string; evidenceKind: string; reporterKind: string }[] }>('GET', `/public/blocklist/${PAYEE}`);
out(`   HTTP ${pub.status} ${JSON.stringify(pub.body.data)}`);

out("\n4. The agent's preflight on a payment to this payee (live vault reads; signing disabled)");
// a random key: the vault object is used for views only, and every signing dep below throws
const vault = createVault({ rpcUrl: NEAR.rpcUrl, vaultId: shop, privateKey: KeyPair.fromRandom('ed25519').toString(), txApiUrl: NEAR.txApiUrl, payTgas: 30, callTgas: 30, listedOnly: false });
const st = await vault.getStatus();
const agentInbox = process.env.INBOX_URL && process.env.INBOX_TOKEN ? createInbox({ url: process.env.INBOX_URL, token: process.env.INBOX_TOKEN, stateFile: '/dev/null' }) : null;
const blocklist = async (id: string): Promise<BlocklistFacts> => {
  if (agentInbox) return agentInbox.blocklist(id);
  const r = await api<{ listed: boolean; count: number; entries: { evidenceTx: string }[] }>('GET', `/public/blocklist/${id}`);
  if (!r.body.success) throw new Error(`public blocklist ${r.status}`);
  return { listed: r.body.data.listed, count: r.body.data.count, firstEvidenceTx: r.body.data.entries[0]?.evidenceTx ?? null };
};
out(`   blocklist lookup through ${agentInbox ? `the agent's inbox client (${process.env.INBOX_URL}/blocklist)` : 'GET /public/blocklist (no INBOX_TOKEN set)'}`);
const signed: string[] = [];
const refuse = (what: string) => async () => {
  signed.push(what);
  throw new Error(`blocklist-demo signs nothing (${what})`);
};
const audit: Record<string, unknown>[] = [];
const runTool = createRunTool({
  ...vault,
  reservedAccounts: [shop, st.token_id, ...(st.intents_id ? [st.intents_id] : [])],
  getVendor: async () => null,
  decline: refuse('decline'),
  pay: refuse('pay'),
  propose: refuse('propose'),
  blocklist,
  intentsEnabled: false,
  tokenDecimals: 6,
  audit: (msg, f) => audit.push({ msg, ...f }),
});
const tool = st.mode === 'Armed' ? 'pay' : 'propose';
const invoiceId = 'ab'.repeat(32);
const res = await runTool(tool, JSON.stringify({ invoice_id: invoiceId, payee: PAYEE, amount_usdc: '1.00', rail: 'Near' }), { invoiceId, mode: st.mode as 'Armed' });
out(`   vault mode ${st.mode}, so the agent's money tool is ${tool}`);
out(`   result ${JSON.stringify(res.output)}`);
const o = res.output as { verdict?: string; reasons?: { code: string }[] };
const blocked = o.verdict === 'block' && !!o.reasons?.some((r) => r.code === 'blocklisted') && signed.length === 0;
out(`\n${blocked ? 'PASS' : 'FAIL'}: verdict ${o.verdict}, blocklisted ${!!o.reasons?.some((r) => r.code === 'blocklisted')}, transactions signed ${signed.length}`);

mkdirSync(join(import.meta.dir, 'out'), { recursive: true });
const file = join(import.meta.dir, 'out', `blocklist-${shop.split('.')[0]}-${new Date().toISOString().slice(0, 10)}.log`);
writeFileSync(file, lines.join('\n') + '\n');
console.log(`log written to ${file}`);
process.exit(blocked ? 0 : 1);
