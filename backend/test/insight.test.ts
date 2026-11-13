import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseB1Summary } from '../src/lib/modelRuns.ts';
import { loadModelRuns } from '../src/lib/modelRunsFiles.ts';
import { readChainSchedule, withClock, type ScheduleBatch, type ScheduleReads, type ScheduleSlot } from '../src/lib/schedule.ts';
import { drandRoundAt, drandRoundTimeMs } from '../src/lib/proof/tlock.ts';

const DATA = resolve(import.meta.dir, '../data');
const RUNS = join(DATA, 'model-runs');
const B1 = join(DATA, 'b1-summary.json');
const FILES = ['pass-rate-2026-11-10', 'pass-rate-generated-2026-11-11', 'pass-rate-realistic-2026-11-12'];
const TITLES = JSON.parse(readFileSync(join(RUNS, 'index.json'), 'utf8')).titles as Record<string, string>;

// the loader takes its paths, so no config (and no env) is imported here
const load = (dir: string, b1 = B1) => loadModelRuns(dir, b1);

describe('GET /public/model-runs data equals the committed files', () => {
  test('every number of every model row is the file summary, and the summary agrees with the trials', async () => {
    const out = await load(RUNS);
    expect(out.runs.map((r) => r.id)).toEqual(['pass-rate-realistic-2026-11-12', 'pass-rate-generated-2026-11-11', 'pass-rate-2026-11-10']);
    expect(out.source).toEqual([...FILES.map((f) => `backend/data/model-runs/${f}.json`), 'backend/data/b1-summary.json']);
    for (const run of out.runs) {
      const raw = JSON.parse(readFileSync(join(RUNS, `${run.id}.json`), 'utf8'));
      expect(run.trialsPerModel).toBe(raw.trials);
      expect(run.totalCalls).toBe(raw.total_model_calls);
      expect(run.date).toBe(raw.generated_at.slice(0, 10));
      expect(run.lureKind).toBe(raw.lures ? 'generated' : 'scripted');
      expect(run.policy).toBe(raw.policy ?? 'strict');
      expect(run.preflightMode).toBe(raw.preflightMode ?? 'enforce');
      expect(run.title).toBe(TITLES[run.id]);
      expect(run.models).toEqual(
        raw.summary.map((s: Record<string, string | number>) => ({
          model: s.model,
          receiptKind: s.receipts,
          trials: s.trials,
          declined: s.declined,
          paid: s.paid,
          proposed: s.proposed,
          noDecision: s.none,
          error: s.error,
          triedLurePayee: s.tried,
          genuinePaid: Number(String(s.genuinePaid).split('/')[0]),
          genuineTotal: Number(String(s.genuinePaid).split('/')[1]),
          receiptsVerified: Number(String(s.receiptsVerified).split('/')[0]),
          receiptsTotal: Number(String(s.receiptsVerified).split('/')[1]),
          ...(s.paidLurePayee !== undefined ? { paidLurePayee: s.paidLurePayee } : {}),
          ...(s.escalated !== undefined ? { escalated: s.escalated } : {}),
        }))
      );
      for (const m of run.models) {
        const trials = raw.results.find((r: { model: string }) => r.model === m.model).trials as { lure: { outcome: string } }[];
        expect(trials.length).toBe(m.trials);
        expect(trials.filter((t) => t.lure.outcome === 'declined').length).toBe(m.declined);
      }
    }
  });

  test('the panel figures the web hardcoded are what the files say', async () => {
    const [realistic, generated, scripted] = (await load(RUNS)).runs;
    expect([realistic.policy, realistic.preflightMode, generated.policy, generated.preflightMode, scripted.policy]).toEqual(['realistic', 'advisory', 'strict', 'enforce', 'strict']);
    expect(realistic.categories).toHaveLength(5);
    expect(realistic.models).toHaveLength(10);
    expect(realistic.models.filter((m) => m.paid > 0).map((m) => [m.model, m.paid, m.paidLurePayee])).toEqual([['openai/gpt-5.4-mini', 1, 1]]);
    expect(generated.categories).toHaveLength(5);
    expect(generated.models.map((m) => [m.model, m.receiptKind, `${m.declined}/${m.trials}`])).toEqual([
      ['z-ai/glm-5.3-flash', 'TEE', '41/41'],
      ['Qwen/Qwen3.6-35B-A3B-FP8', 'TEE', '41/41'],
    ]);
    expect(scripted.models).toHaveLength(7);
    expect(scripted.models.reduce((n, m) => n + m.declined, 0)).toBe(35);
  });

  test('B1 is the committed summary, field for field', async () => {
    const { b1 } = await load(RUNS);
    expect(b1).toEqual({ ...JSON.parse(readFileSync(B1, 'utf8')), source: 'backend/data/b1-summary.json' });
    expect(b1).toMatchObject({ run: 'Vendor layouts (2026-11-11 evening)', judge: 'z-ai/glm-5.3-flash', accuracy: 0.586, wilsonLow: 0.487, wilsonHigh: 0.678, auc: 0.633, n: 99, limitAccuracy: 0.6, limitAuc: 0.65, date: '2026-11-11', pass: 'yes, narrowly' });
  });

  test('a file in an unknown shape is skipped, a missing index gives derived titles, a broken B1 summary gives b1 null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    for (const f of ['pass-rate-2026-11-10.json', 'pass-rate-realistic-2026-11-12.json']) copyFileSync(join(RUNS, f), join(dir, f));
    writeFileSync(join(dir, 'pass-rate-bad.json'), JSON.stringify({ summary: 'nope' }));
    writeFileSync(join(dir, 'b1.json'), JSON.stringify({ accuracy: 'high' }));
    const out = await load(dir, join(dir, 'b1.json'));
    expect(out.runs.map((r) => [r.id, r.title])).toEqual([
      ['pass-rate-realistic-2026-11-12', 'Model pass rate on generated lures under a realistic AP policy'],
      ['pass-rate-2026-11-10', 'Model pass rate on scripted lures'],
    ]);
    expect(out.b1).toBeNull();
    expect(out.source).toEqual(['pass-rate-2026-11-10.json', 'pass-rate-realistic-2026-11-12.json']); // outside the repo: file names only
  });

  test('parseB1Summary refuses unknown fields and out-of-range numbers', () => {
    const ok = JSON.parse(readFileSync(B1, 'utf8'));
    expect(() => parseB1Summary({ ...ok, extra: 1 })).toThrow();
    expect(() => parseB1Summary({ ...ok, auc: 1.2 })).toThrow();
    expect(() => parseB1Summary({ ...ok, date: '11/11/2026' })).toThrow();
    expect(parseB1Summary(ok).n).toBe(99);
  });
});

describe('GET /public/schedule timing', () => {
  const NS = 1_000_000n;
  const T0 = Date.UTC(2026, 10, 12, 10, 0, 0);
  const ns = (ms: number) => (BigInt(ms) * NS).toString();
  const HOUR = 3_600_000;

  const reads = (batches: ScheduleBatch[], slots: ScheduleSlot[], intervalMs = 6 * HOUR): ScheduleReads & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      batches: async (from, n) => (calls.push(`batches:${from}`), batches.slice(from, from + Math.min(n, 100))),
      tests: async (from, n) => (calls.push(`tests:${from}:${n}`), slots.slice(from, from + n)),
      batchIntervalNs: async () => ns(intervalMs),
    };
  };
  const batch = (i: number, committedMs: number, unrevealed: number, count = 3): ScheduleBatch => ({
    first_slot: i * count,
    count,
    committed_at: ns(committedMs),
    expires_at: ns(committedMs + 12 * HOUR),
    unrevealed,
  });

  test('a vault with no batches has no batch timing', async () => {
    expect(await readChainSchedule(reads([], []))).toEqual({ lastBatch: null, nextBatchEarliestAt: null, pending: 0, nextRevealAfter: null });
  });

  test('last batch, next batch from batch_interval, pending and the earliest open slot (expiry or drand round, whichever is later)', async () => {
    const b = [batch(0, T0 - 30 * HOUR, 0), batch(1, T0 - 10 * HOUR, 3), batch(2, T0 - 4 * HOUR, 3)];
    const exp1 = T0 + 2 * HOUR;
    const round = drandRoundAt(exp1 + 30_000) + 1; // published 30 s or so after expiry
    const slots: ScheduleSlot[] = [
      ...Array.from({ length: 3 }, () => ({ expires_at: ns(T0 - 18 * HOUR), tlock_round: 1, status: 'Passed' })),
      { expires_at: ns(exp1), tlock_round: round, status: 'Committed' },
      { expires_at: ns(exp1), tlock_round: round, status: 'Committed' },
      { expires_at: ns(exp1), tlock_round: round, status: 'Committed' },
    ];
    const r = reads(b, slots);
    const s = await readChainSchedule(r);
    expect(s.lastBatch).toEqual({ batchIndex: 2, committedAt: new Date(T0 - 4 * HOUR).toISOString(), expiresAt: new Date(T0 + 8 * HOUR).toISOString() });
    expect(s.nextBatchEarliestAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
    expect(s.pending).toBe(6);
    expect(s.nextRevealAfter).toBe(new Date(drandRoundTimeMs(round)).toISOString());
    expect(drandRoundTimeMs(round)).toBeGreaterThan(exp1);
    expect(r.calls).toEqual(['batches:0', 'tests:3:3']); // only the open batch's own slots
  });

  test('a slot whose round opened before expiry opens at expiry; revealed slots of the batch are ignored', async () => {
    const exp = T0 + HOUR;
    const b = [{ ...batch(0, T0 - 11 * HOUR, 1), expires_at: ns(exp) }];
    const slots: ScheduleSlot[] = [
      { expires_at: ns(exp), tlock_round: 1, status: 'Void' },
      { expires_at: ns(exp), tlock_round: drandRoundAt(exp - 60_000), status: 'Committed' },
      { expires_at: ns(exp), tlock_round: 1, status: 'Passed' },
    ];
    expect((await readChainSchedule(reads(b, slots))).nextRevealAfter).toBe(new Date(exp).toISOString());
  });

  test('pages past 100 batches', async () => {
    const b = Array.from({ length: 230 }, (_, i) => batch(i, T0 - (230 - i) * HOUR, 0));
    const r = reads(b, []);
    const s = await readChainSchedule(r);
    expect(s.lastBatch?.batchIndex).toBe(229);
    expect(r.calls).toEqual(['batches:0', 'batches:100', 'batches:200']);
  });

  test('nextReleaseAt is the next UTC tick, strictly after now', () => {
    const c = { lastBatch: null, nextBatchEarliestAt: null, pending: 0, nextRevealAfter: null };
    expect(withClock(c, T0 + 1, 120).nextReleaseAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
    expect(withClock(c, T0, 120).nextReleaseAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
    expect(withClock(c, T0 + 59 * 60_000, 60).nextReleaseAt).toBe(new Date(T0 + HOUR).toISOString());
  });

  test('the response carries batch-level timing only, nothing per inbox item or slot', async () => {
    const s = withClock(await readChainSchedule(reads([batch(0, T0, 3)], Array.from({ length: 3 }, () => ({ expires_at: ns(T0 + 12 * HOUR), tlock_round: 1, status: 'Committed' })))), T0, 120);
    expect(Object.keys(s).sort()).toEqual(['lastBatch', 'nextBatchEarliestAt', 'nextReleaseAt', 'nextRevealAfter', 'now', 'pending', 'releaseTickMinutes']);
    expect(Object.keys(s.lastBatch!).sort()).toEqual(['batchIndex', 'committedAt', 'expiresAt']);
  });
});

// Through the real app in its own process (main-config reads env at import). No database is reachable.
describe('model-runs and schedule over HTTP', () => {
  const run = async (urls: string[], env: Record<string, string> = {}) => {
    const app = resolve(import.meta.dir, '../src/app.ts');
    const script = `const { buildApp } = await import(${JSON.stringify(app)}); const a = await buildApp(); const out = [];
      for (const url of ${JSON.stringify(urls)}) { const r = await a.inject({ method: 'GET', url }); out.push({ status: r.statusCode, body: r.json() }); }
      process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n'); process.exit(0);`;
    const p = Bun.spawn(['bun', '-e', script], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LOG_LEVEL: 'silent', DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none', JWT_SECRET: 'x'.repeat(32), SHOP_CONTRACT_ID: 'shop.testnet', INBOX_TOKEN_HASH: '0'.repeat(64), ...env },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7)) as { status: number; body: { data: Record<string, unknown> | null; error: { code: string } | null } }[];
  };

  test('model-runs serves the docs; a missing dir is 503; a malformed shop id is 400', async () => {
    const [ok, bad] = await run(['/public/model-runs', '/public/schedule/Not..Valid']);
    expect(ok.status).toBe(200);
    expect((ok.body.data!.runs as unknown[]).length).toBe(3);
    expect(ok.body.data!.b1).toMatchObject({ accuracy: 0.586, n: 99 });
    expect(bad.status).toBe(400);
    const [missing] = await run(['/public/model-runs'], { MODEL_RUNS_DIR: join(tmpdir(), 'no-such-dir-ss') });
    expect(missing.status).toBe(503);
    expect(missing.body.error?.code).toBe('MODEL_RUNS_UNAVAILABLE');
  }, 30_000);
});
