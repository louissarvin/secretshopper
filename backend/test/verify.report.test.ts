import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseVerifyReport } from '../src/lib/verifyReport.ts';

// test/fixtures/verify-report.json is a real scripts/out/verify-report.json (2026-11-12 run).
const FIXTURE = resolve(import.meta.dir, 'fixtures/verify-report.json');
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('verify report parsing', () => {
  test('counts from the fixture, each one present in its own summary line', () => {
    const sum = (name: string) => raw.results.find((s: { step: string }) => s.step.startsWith(name)).summary as string;
    const r = parseVerifyReport(raw);
    expect(r).toMatchObject({ generatedAt: raw.ranAt, platform: 'darwin arm64', bun: '1.4.4', ok: true, passed: 12, failed: 0, skipped: 0 });
    expect(r.codeHash).toBe('5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs');
    expect(sum('contract wasm build')).toBe(`SHA-256 checksum bs58: ${r.codeHash}`);
    expect(r.counts).toEqual({
      contractUnit: 18,
      contractAudit: 4,
      contractCost: 1,
      contractSandbox: 35,
      backendPass: 251,
      backendSkip: 24,
      backendFail: 0,
      agentPass: 87,
      agentFail: 0,
      demoChecks: 33,
      mcpChecks: 35,
    });
    expect(r.steps).toEqual(raw.results);
    expect(sum('contract tests')).toStartWith('test result: ok. 18 passed; 0 failed; test result: ok. 4 passed; 0 failed; test result: ok. 1 passed; 0 failed; test result: ok. 35 passed');
    expect(sum('backend tests')).toBe('251 pass; 24 skip; 0 fail');
    expect(sum('agent tests')).toBe('87 pass; 0 fail');
    expect(sum('end-to-end demo')).toContain('PASS: all 33 checks held');
    expect(sum('bring-your-own-agent')).toContain('PASS: all 35 checks held');
  });

  test('a failed or skipped step gives null counts and flips ok; no skip line is 0 skipped', () => {
    const results = raw.results.map((s: { step: string; summary: string }) =>
      s.step === 'backend tests'
        ? { ...s, status: 'fail', summary: 'exit 1: 3 fail (full log: scripts/out/verify/backend-tests.log)' }
        : s.step.startsWith('end-to-end') ? { ...s, status: 'skip', seconds: 0, summary: 'skipped by --skip-demo' } : s.step === 'agent tests' ? { ...s, summary: '90 pass; 0 fail' } : s
    );
    const r = parseVerifyReport({ ...raw, results });
    expect(r).toMatchObject({ ok: false, passed: 10, failed: 1, skipped: 1 });
    expect(r.counts).toMatchObject({ backendPass: null, backendSkip: null, backendFail: null, demoChecks: null, agentPass: 90, agentFail: 0, mcpChecks: 35 });
    const failedBuild = parseVerifyReport({ ...raw, results: raw.results.map((x: { step: string }) => (x.step.startsWith('contract wasm build') ? { ...x, status: 'fail', summary: 'exit 101' } : x)) });
    expect(failedBuild.codeHash).toBeNull();
  });

  test('unparseable summaries are null, fewer than four cargo targets give no contract counts', () => {
    const results = raw.results.map((s: { step: string; summary: string }) =>
      s.step.startsWith('contract tests') ? { ...s, summary: 'test result: ok. 18 passed; 0 failed' } : s.step.includes('MCP') ? { ...s, summary: 'done' } : s
    );
    expect(parseVerifyReport({ ...raw, results }).counts).toMatchObject({ contractUnit: null, contractAudit: null, contractCost: null, contractSandbox: null, mcpChecks: null });
  });

  test('generatedAt and steps are accepted as aliases; a report without steps is refused', () => {
    const { ranAt, results, ...rest } = raw;
    expect(parseVerifyReport({ ...rest, generatedAt: ranAt, steps: results }).generatedAt).toBe(ranAt);
    expect(() => parseVerifyReport({ ranAt })).toThrow();
    expect(() => parseVerifyReport({ results: [{ step: 'x', status: 'maybe', seconds: 1, summary: '' }] })).toThrow();
  });
});

describe('GET /public/verify-report', () => {
  const run = async (env: Record<string, string>) => {
    const app = resolve(import.meta.dir, '../src/app.ts');
    const script = `const { buildApp } = await import(${JSON.stringify(app)}); const a = await buildApp(); const r = await a.inject({ method: 'GET', url: '/public/verify-report' });
      process.stdout.write('\\nRESULT ' + JSON.stringify({ status: r.statusCode, body: r.json() }) + '\\n'); process.exit(0);`;
    const p = Bun.spawn(['bun', '-e', script], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LOG_LEVEL: 'silent', DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none', JWT_SECRET: 'x'.repeat(32), SHOP_CONTRACT_ID: 'shop.testnet', INBOX_TOKEN_HASH: '0'.repeat(64), ...env },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7)) as { status: number; body: { data: Record<string, unknown> | null; error: { code: string } | null } };
  };

  test('serves the parsed report, also in the hosted read-only app; a missing file is 503', async () => {
    const ok = await run({ VERIFY_REPORT_PATH: FIXTURE });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ passed: 12, counts: { backendPass: 251, contractSandbox: 35 } });
    const hosted = await run({ VERIFY_REPORT_PATH: FIXTURE, HOSTED_READONLY: '1' });
    expect(hosted.status).toBe(200);
    const missing = await run({ VERIFY_REPORT_PATH: join(tmpdir(), 'no-verify-report-here.json') });
    expect(missing.status).toBe(503);
    expect(missing.body.error?.code).toBe('VERIFY_REPORT_UNAVAILABLE');
  }, 30_000);
});
