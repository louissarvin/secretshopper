// One command for reviewers: `bun run verify` from the repo root. Runs every check that needs no secret
// and prints a table plus a JSON report (scripts/out/verify-report.json). Exit 0 only if every step passed.
// Flags: --skip-contract (no Rust toolchain), --skip-demo (no drand access), --record (also write the tracked
// backend/data/verify-report.json, only when every step passed with none skipped; a plain run leaves the tree clean).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(import.meta.dir, '..');
const args = new Set(process.argv.slice(2));

type Step = { name: string; cwd: string; cmd: string[]; expect: RegExp; summary: (out: string) => string; skip?: string };

const last = (re: RegExp) => (out: string) => [...out.matchAll(new RegExp(re.source, 'gm'))].map((m) => m[0].trim()).join('; ') || 'no summary line';

// The wasm embeds cargo registry paths; mapping this machine's CARGO_HOME to the one shop4 was built with
// makes the build byte-identical to the deployed global contract on any machine with the pinned toolchain.
const DEPLOYED_HASH = '5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs';
const CARGO_HOME = process.env.CARGO_HOME || join(homedir(), '.cargo');
const REMAP = `RUSTFLAGS=-C link-arg=-s --remap-path-prefix=${CARGO_HOME}=/Users/macbookair/.cargo`;

const steps: Step[] = [
  {
    name: 'contract wasm build (equals shop4 code hash)',
    cwd: 'contracts/shop',
    cmd: ['cargo', 'near', 'build', 'non-reproducible-wasm', '--env', REMAP],
    expect: new RegExp(`SHA-256 checksum bs58: ${DEPLOYED_HASH}`),
    summary: last(/SHA-256 checksum bs58: \w+/),
    skip: args.has('--skip-contract') ? '--skip-contract' : undefined,
  },
  {
    name: 'contract ft fixture build',
    cwd: 'contracts/shop/tests/fixtures/ft',
    cmd: ['cargo', 'near', 'build', 'non-reproducible-wasm', '--no-abi'],
    expect: /SHA-256 checksum/,
    summary: () => 'built',
    skip: args.has('--skip-contract') ? '--skip-contract' : undefined,
  },
  {
    name: 'contract tests (unit, audit, costs, sandbox)',
    cwd: 'contracts/shop',
    cmd: ['cargo', 'test', '--', '--test-threads=4'],
    expect: /test result: ok/,
    summary: last(/test result: ok\. \d+ passed; 0 failed/),
    skip: args.has('--skip-contract') ? '--skip-contract' : undefined,
  },
  {
    name: 'contract clippy',
    cwd: 'contracts/shop',
    cmd: ['cargo', 'clippy', '--all-targets', '--', '-D', 'warnings'],
    expect: /Finished/,
    summary: () => 'clean',
    skip: args.has('--skip-contract') ? '--skip-contract' : undefined,
  },
  { name: 'backend tests', cwd: 'backend', cmd: ['bun', 'test'], expect: /\b0 fail\b/, summary: last(/^ *\d+ (pass|skip|fail)$/) },
  { name: 'backend typecheck', cwd: 'backend', cmd: ['bun', 'run', 'typecheck'], expect: /tsc --noEmit/, summary: () => 'clean' },
  { name: 'backend lint', cwd: 'backend', cmd: ['bun', 'run', 'lint'], expect: /eslint/, summary: () => 'clean' },
  { name: 'agent tests', cwd: 'agent', cmd: ['bun', 'test'], expect: /\b0 fail\b/, summary: last(/^ *\d+ (pass|fail)$/) },
  { name: 'agent typecheck', cwd: 'agent', cmd: ['bun', 'run', 'typecheck'], expect: /tsc --noEmit/, summary: () => 'clean' },
  { name: 'scripts typecheck', cwd: 'scripts', cmd: ['bun', 'run', 'typecheck'], expect: /tsc --noEmit/, summary: () => 'clean' },
  {
    name: 'end-to-end demo (local sandbox)',
    cwd: 'scripts',
    cmd: ['bun', 'demo.ts'],
    expect: /^PASS: all \d+ checks held/m,
    summary: last(/^PASS: all \d+ checks held in [\d.]+s\./),
    skip: args.has('--skip-demo') ? '--skip-demo' : undefined,
  },
  {
    name: 'bring-your-own-agent over MCP (local sandbox)',
    cwd: 'scripts',
    cmd: ['bun', 'mcp-e2e.ts'],
    expect: /^PASS: all \d+ checks held/m,
    summary: last(/^PASS: all \d+ checks held in [\d.]+s\./),
    skip: args.has('--skip-demo') ? '--skip-demo' : undefined,
  },
];

// Stack frames hide the cause; keep the last message lines and point at the full log.
const lastMessage = (out: string): string =>
  out.split('\n').filter((l) => l.trim() && !/^\s+at /.test(l)).slice(-2).join(' | ').trim().slice(0, 300);

const logName = (step: string): string => `${step.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.log`;

type Result = { step: string; status: 'pass' | 'fail' | 'skip'; seconds: number; summary: string };
const results: Result[] = [];

for (const s of steps) {
  if (s.skip) {
    results.push({ step: s.name, status: 'skip', seconds: 0, summary: `skipped by ${s.skip}` });
    continue;
  }
  process.stderr.write(`running: ${s.name}\n`);
  const t0 = performance.now();
  // empty secrets on purpose: every step here must pass without a .env (AGENTS.md "What needs secrets")
  const p = Bun.spawnSync(s.cmd, { cwd: join(ROOT, s.cwd), env: { ...process.env, NEARAI_API_KEY_AGENT: '' }, stdout: 'pipe', stderr: 'pipe' });
  const out = p.stdout.toString() + p.stderr.toString();
  // full output per step, so a failure's cause is readable without rerunning
  mkdirSync(join(import.meta.dir, 'out', 'verify'), { recursive: true });
  writeFileSync(join(import.meta.dir, 'out', 'verify', logName(s.name)), out);
  const ok = p.exitCode === 0 && s.expect.test(out);
  const seconds = Math.round((performance.now() - t0) / 100) / 10;
  results.push({ step: s.name, status: ok ? 'pass' : 'fail', seconds, summary: ok ? s.summary(out) : `exit ${p.exitCode}: ${lastMessage(out)} (full log: scripts/out/verify/${logName(s.name)})` });
}

const pad = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}~` : v.padEnd(n));
console.log(`\n${pad('step', 46)} ${pad('status', 6)} ${pad('time', 8)} summary`);
for (const r of results) console.log(`${pad(r.step, 46)} ${pad(r.status, 6)} ${pad(`${r.seconds}s`, 8)} ${r.summary}`);

const failed = results.filter((r) => r.status === 'fail');
const report = { ranAt: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, bun: Bun.version, passed: failed.length === 0, results };
mkdirSync(join(import.meta.dir, 'out'), { recursive: true });
writeFileSync(join(import.meta.dir, 'out', 'verify-report.json'), JSON.stringify(report, null, 2) + '\n');
// --record keeps a complete green run as evidence; the API serves it to the web (GET /public/verify-report).
if (args.has('--record')) {
  if (results.every((r) => r.status === 'pass')) {
    writeFileSync(join(import.meta.dir, '..', 'backend', 'data', 'verify-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('\n--record: wrote backend/data/verify-report.json');
  } else {
    console.log('\n--record: backend/data/verify-report.json left unchanged; every step must pass with none skipped');
  }
}
console.log(failed.length === 0 ? `\nVERIFY PASS: ${results.filter((r) => r.status === 'pass').length} steps passed, ${results.filter((r) => r.status === 'skip').length} skipped.` : `\nVERIFY FAIL: ${failed.map((r) => r.step).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
