/**
 * `bun run live`: preflight, then the API, the tester and the agent as three processes, each with its own env file.
 * The agent never starts without NEARAI_API_KEY_AGENT (no naive agent on a live vault); the tester never generates
 * tests without NEARAI_API_KEY_TESTER and Bun >= 1.4.4 (it still recovers and reveals).
 * Usage: bun live.ts [--preflight]       Env values are read from the files and never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { KeyPair, type KeyPairString } from 'near-api-js';

const ROOT = resolve(import.meta.dir, '..');
const FILES = { api: join(ROOT, 'backend/.env'), tester: join(ROOT, 'backend/.env.tester'), agent: join(ROOT, 'agent/.env') };

// Minimal dotenv reader: KEY=VALUE, optional quotes, inline " #" comments on unquoted values.
const readEnv = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^["']/.test(v)) v = v.slice(1, v.indexOf(v[0], 1));
    else if (v.startsWith('#')) v = ''; // KEY=   # comment is empty, as Bun reads it
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
};

type Result = { name: string; ok: boolean; detail: string; blocks: ('api' | 'tester' | 'agent' | 'generation')[] };
const results: Result[] = [];
const check = (name: string, ok: boolean, detail: string, blocks: Result['blocks'] = []) => results.push({ name, ok, detail, blocks });

const bunAtLeast = (min: string) => {
  const [a, b, c] = Bun.version.split('.').map(Number);
  const [x, y, z] = min.split('.').map(Number);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
};

const env = { api: readEnv(FILES.api), tester: readEnv(FILES.tester), agent: readEnv(FILES.agent) };
for (const [k, f] of Object.entries(FILES)) check(`${k} env file`, existsSync(f), f.replace(ROOT + '/', ''), [k as 'api']);

check('Bun >= 1.4.4', bunAtLeast('1.4.4'), `running ${Bun.version}; the tester's NEAR AI client (inference SDK TLS binding) needs 1.4.4`, ['generation']);
check('NEARAI_API_KEY_TESTER', !!env.tester.NEARAI_API_KEY_TESTER, env.tester.NEARAI_API_KEY_TESTER ? 'set' : 'not set in backend/.env.tester: the tester will not generate tests', ['generation']);
check('NEARAI_API_KEY_AGENT', !!env.agent.NEARAI_API_KEY_AGENT, env.agent.NEARAI_API_KEY_AGENT ? 'set' : 'not set in agent/.env: the agent will not start (no naive agent on a live vault)', ['agent']);

const shop = env.api.SHOP_CONTRACT_ID;
check('one vault everywhere', !!shop && env.tester.SHOP_CONTRACT_ID === shop && env.agent.AGENT_VAULT_ID === shop, `api ${shop}, tester ${env.tester.SHOP_CONTRACT_ID}, agent ${env.agent.AGENT_VAULT_ID}`, ['api', 'tester', 'agent']);
const prod = env.api.NODE_ENV === 'production';
check('AUTH_RECIPIENT', !(prod && /^(localhost|127\.0\.0\.1)/.test(env.api.AUTH_RECIPIENT ?? 'localhost')), `${env.api.AUTH_RECIPIENT ?? '(default localhost)'}${prod ? ' (production)' : ' (development)'}`, ['api']);
check(
  'inbox token matches',
  !!env.agent.INBOX_TOKEN && createHash('sha256').update(env.agent.INBOX_TOKEN).digest('hex') === (env.api.INBOX_TOKEN_HASH ?? '').toLowerCase(),
  'sha256(agent INBOX_TOKEN) vs backend INBOX_TOKEN_HASH',
  ['agent']
);

// Chain checks run with the API's network settings.
Object.assign(process.env, { NEAR_NETWORK: env.api.NEAR_NETWORK ?? 'testnet', ...(env.api.NEAR_RPC_URL ? { NEAR_RPC_URL: env.api.NEAR_RPC_URL } : {}) });
const { provider, view } = await import('./lib/net.ts');
const pkOf = (k?: string) => {
  try {
    return k ? KeyPair.fromString(k as KeyPairString).getPublicKey().toString() : null;
  } catch {
    return null;
  }
};
try {
  const st = await view<{ mode: string; version: string; agent_key: string | null; owner_id: string; token_id: string }>(shop, 'get_status');
  check('vault v2', /^2\./.test(st.version), `version ${st.version}`, ['tester', 'agent']);
  check('vault mode', st.mode === 'Armed' || st.mode === 'Demoted', `mode ${st.mode}`, ['agent']);
  check('agent key is the armed key', pkOf(env.agent.AGENT_PRIVATE_KEY) === st.agent_key, `vault agent_key ${st.agent_key?.slice(0, 16)}...`, ['agent']);
  check('tester token', env.tester.USDC_CONTRACT_ID === st.token_id, `vault token ${st.token_id}`, ['tester']);
  const policy = await view<{ reveal_grace: string }>(shop, 'get_policy');
  check('reveal_grace >= 9 s (tlock)', BigInt(policy.reveal_grace) >= 9_000_000_000n, `${Number(BigInt(policy.reveal_grace) / 1_000_000_000n)} s`, ['tester']);
  const testerPk = pkOf(env.tester.TESTER_PRIVATE_KEY);
  check('tester account is the owner', env.tester.TESTER_ACCOUNT_ID === st.owner_id, `owner ${st.owner_id}`, ['tester']);
  try {
    const ak = await provider.viewAccessKey({ accountId: st.owner_id, publicKey: testerPk ?? '' });
    const fc = (ak.permission as { FunctionCall?: { receiver_id: string; method_names: string[]; allowance: string | null } }).FunctionCall;
    const methods = fc ? [...fc.method_names].sort().join(',') : 'FullAccess';
    // 2.3.0 adds release and prove_delivery (v2/32, V23-02); older vaults have no such methods
    const [major, minor] = st.version.split('.').map(Number);
    const want = major > 2 || (major === 2 && minor >= 3) ? 'commit_batch,prove_delivery,release,reveal' : 'commit_batch,reveal';
    check(
      'tester key permissions',
      !!fc && fc.receiver_id === shop && methods === want,
      `${methods} on ${fc?.receiver_id ?? '(any)'}, allowance ${fc?.allowance ? (Number(fc.allowance) / 1e24).toFixed(3) + ' NEAR' : 'none'}`,
      ['tester']
    );
  } catch (e) {
    check('tester key permissions', false, `key not found on ${st.owner_id}: ${(e as Error).message.slice(0, 80)}`, ['tester']);
  }
} catch (e) {
  check('vault reachable', false, `${shop}: ${(e as Error).message.slice(0, 120)}`, ['api', 'tester', 'agent']);
}

// DB checks run in the backend package with each env file loaded by Bun itself; only role facts come back.
const dbProbe = (envFile: string) => {
  const code = `import pg from 'pg'; const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try { await c.connect(); const r = await c.query("select current_user as u, has_schema_privilege(current_user, 'tester', 'USAGE') as t, (select count(*) from public.companies where \\"shopContractId\\" = $1)::int as c", [process.env.SHOP_CONTRACT_ID]);
      console.log(JSON.stringify(r.rows[0])); } catch (e) { console.log(JSON.stringify({ error: e.code || e.message })); } finally { await c.end().catch(() => {}); }`;
  const p = Bun.spawnSync(['bun', `--env-file=${envFile}`, '-e', code], { cwd: join(ROOT, 'backend') });
  try {
    return JSON.parse(p.stdout.toString().trim().split('\n').pop() ?? '{}') as { u?: string; t?: boolean; c?: number; error?: string };
  } catch {
    return { error: 'probe failed' };
  }
};
const apiDb = dbProbe('.env');
const testerDb = dbProbe('.env.tester');
check('API DB role', !apiDb.error && apiDb.t === false, apiDb.error ? `error ${apiDb.error}` : `${apiDb.u}, schema tester ${apiDb.t ? 'VISIBLE (run prisma/roles.sql)' : 'not visible'}`, ['api']);
check('tester DB role', !testerDb.error && testerDb.t === true, testerDb.error ? `error ${testerDb.error}` : `${testerDb.u}, schema tester ${testerDb.t ? 'usable' : 'NOT usable'}`, ['tester']);
check('company registered', (apiDb.c ?? 0) > 0, apiDb.c ? 'yes' : 'no: run bun scripts/owner-register.ts', ['tester']);

console.log('Preflight');
for (const r of results) console.log(`  ${r.ok ? 'ok     ' : 'MISSING'} ${r.name}: ${r.detail}`);
const blocked = (what: Result['blocks'][number]) => results.filter((r) => !r.ok && r.blocks.includes(what)).map((r) => r.name);
const plan = {
  api: blocked('api'),
  tester: blocked('tester'),
  agent: blocked('agent'),
  generation: blocked('generation'),
};
console.log(`\n  api:        ${plan.api.length ? 'will NOT start: ' + plan.api.join(', ') : 'will start'}`);
console.log(`  tester:     ${plan.tester.length ? 'will NOT start: ' + plan.tester.join(', ') : plan.generation.length ? 'will start without test generation (recovery and reveals only): ' + plan.generation.join(', ') : 'will start with test generation'}`);
console.log(`  agent:      ${plan.agent.length ? 'will NOT start: ' + plan.agent.join(', ') : 'will start'}`);
if (process.argv.includes('--preflight')) process.exit(0);
if (plan.api.length) {
  console.error('\nThe API is required; fix the items above.');
  process.exit(1);
}

const procs: { name: string; proc: ReturnType<typeof Bun.spawn> }[] = [];
const start = (name: string, cwd: string, envFile: string, entry: string) => {
  const proc = Bun.spawn(['bun', `--env-file=${envFile}`, entry], { cwd: join(ROOT, cwd), stdout: 'pipe', stderr: 'pipe' });
  const pipe = async (stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream) => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of stream) {
      buf += dec.decode(chunk);
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(`[${name}] ${l}\n`);
    }
  };
  void pipe(proc.stdout as ReadableStream<Uint8Array>, process.stdout);
  void pipe(proc.stderr as ReadableStream<Uint8Array>, process.stderr);
  procs.push({ name, proc });
};

start('api', 'backend', '.env', 'index.ts');
await Bun.sleep(3_000); // the agent polls the API inbox
if (!plan.tester.length) start('tester', 'backend', '.env.tester', 'tester.ts');
if (!plan.agent.length) start('agent', 'agent', '.env', 'index.ts');

const stopAll = (code: number) => {
  for (const p of procs) p.proc.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3_000);
};
process.once('SIGINT', () => stopAll(0));
process.once('SIGTERM', () => stopAll(0));
// one process dying takes the others down, so a half-running system never looks healthy
for (const p of procs) {
  void p.proc.exited.then((code) => {
    console.error(`[live] ${p.name} exited with code ${code}; stopping the others`);
    stopAll(code || 1);
  });
}
