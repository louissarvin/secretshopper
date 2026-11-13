import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { candidateTicks, nextRealDelivery, TICK_LEAD_MS, testDeliveryTimes } from '../src/utils/delivery.ts';
import { buildEvidence, EVIDENCE_PAGE, pageOfSlots } from '../src/lib/evidence.ts';

// Regression tests for the 2.3.0 backend audit (B23-01 to B23-11). Each inverts the audit's PoC: the attack must now fail.
const ROOT = join(import.meta.dir, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const MIN = 60_000;

// own process: main-config reads env at import time and exits without it; no database is reachable
const inject = async (paths: string[]) => {
  const app = resolve(ROOT, 'src/app.ts');
  const script = `const { buildApp } = await import(${JSON.stringify(app)}); const a = await buildApp(); const out = [];
    for (const url of ${JSON.stringify(paths)}) { const r = await a.inject({ method: 'GET', url }); out.push(r.statusCode); }
    process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n'); process.exit(0);`;
  const p = Bun.spawn(['bun', '-e', script], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
      JWT_SECRET: 'x'.repeat(32),
      SHOP_CONTRACT_ID: 'shop.testnet',
      INBOX_TOKEN_HASH: '0'.repeat(64),
    },
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code, err).toBe(0);
  return JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7)) as number[];
};

describe('B23-01 the public evidence bundle is bounded', () => {
  test('one IP gets at most 20 pages a minute (was the global 120)', async () => {
    const codes = await inject(Array.from({ length: 22 }, () => '/public/evidence/shop.testnet'));
    expect(codes.slice(0, 20).includes(429)).toBe(false);
    expect(codes.slice(20)).toEqual([429, 429]);
  }, 30_000);

  test('pages start on a page boundary, so the cache holds one entry per page', async () => {
    const [mid, negative] = await inject(['/public/evidence/shop.testnet?fromSlot=7', '/public/evidence/shop.testnet?fromSlot=-100']);
    expect(mid).toBe(400);
    expect(negative).toBe(400);
  }, 30_000);

  test('a page holds at most EVIDENCE_PAGE slots and points at the next non-empty page', () => {
    const rows = [3, 50, 99, 100, 250].map((slotIndex) => ({ slotIndex }));
    expect(pageOfSlots(rows, 0)).toEqual({ slots: [{ slotIndex: 3 }, { slotIndex: 50 }, { slotIndex: 99 }], nextFromSlot: 100 });
    expect(pageOfSlots(rows.slice(4), 100)).toEqual({ slots: [], nextFromSlot: 200 });
    expect(pageOfSlots([{ slotIndex: 250 }], 200)).toEqual({ slots: [{ slotIndex: 250 }], nextFromSlot: null });
    const full = Array.from({ length: EVIDENCE_PAGE + 1 }, (_, i) => ({ slotIndex: i }));
    expect(pageOfSlots(full, 0).slots.length).toBe(EVIDENCE_PAGE);
    const bundle = buildEvidence({ network: 'testnet', shop: 's.testnet', batches: [], genLog: [], slots: [], invoices: [], receipts: [], nextFromSlot: 200 });
    expect(bundle.next_from_slot).toBe(200);
  });

  test('slots are read in slot order, one page at a time, receipts scoped to the shop', () => {
    const route = src('src/routes/publicRoutes.ts');
    const page = route.slice(route.indexOf('const evidencePage'), route.indexOf('export const publicRoutes'));
    expect(page).toContain("orderBy: { slotIndex: 'asc' }");
    expect(page).toContain('pageOfSlots(');
    expect(page).toContain('take: EVIDENCE_PAGE + 1');
    expect(route).not.toContain('take: 1000');
    expect(page).toMatch(/aiReceipt\.findMany\(\{ where: \{ companyId, id:/);
    const handler = route.slice(route.indexOf("'/evidence/:shopId'"));
    expect(handler).toContain('{ config: evidenceLimit }');
    expect(handler).toMatch(/cached\(`evidence:\$\{shopId\}:\$\{fromSlot\}`/);
  });
});

describe('B23-02 an invoice row exists before its release tick', () => {
  test('an invoice entered 1 ms before a tick waits for the next one (was: released 1 ms later)', () => {
    const tick = Date.UTC(2026, 10, 10, 12, 0);
    const d = nextRealDelivery(new Date(tick - 1), 120);
    expect(d.getTime()).toBe(tick + 120 * MIN);
    expect(d.getTime() - (tick - 1)).toBeGreaterThanOrEqual(TICK_LEAD_MS);
  });

  test('test ticks also start at least TICK_LEAD_MS after now', () => {
    const now = new Date(Date.UTC(2026, 10, 10, 11, 59, 30));
    const ticks = candidateTicks({ now, expiresAt: new Date(now.getTime() + 48 * 60 * MIN), periodMinutes: 120 });
    expect(ticks[0] - now.getTime()).toBeGreaterThanOrEqual(TICK_LEAD_MS);
  });

  test('the tester takes "now" after its slow reads, right before the insert', () => {
    const w = src('src/tester/workers.ts');
    const fin = w.slice(w.indexOf('const finalize = async'), w.indexOf('const recoverLog'));
    expect(fin.indexOf('await realReleaseHistory(cid)')).toBeLessThan(fin.indexOf('now: new Date()'));
  });
});

describe('B23-03 lures land where an ignored one can be scored', () => {
  test('no test tick after expires_at - min_answer (was: up to half the lifetime whatever min_answer)', () => {
    const now = new Date(Date.UTC(2026, 10, 10, 0, 0, 5));
    const expiresAt = new Date(now.getTime() + 48 * 60 * MIN);
    const answerBy = new Date(expiresAt.getTime() - 40 * 60 * MIN); // min_answer 40 h of a 48 h ttl
    const times = testDeliveryTimes(200, { now, expiresAt, answerBy, periodMinutes: 120, realHistory: [], businessStartHourUtc: 0, businessEndHourUtc: 24 });
    expect(times.length).toBe(200);
    for (const t of times) expect(t.getTime()).toBeLessThanOrEqual(answerBy.getTime());
  });

  test('the tester passes min_answer to every delivery plan and to the commit feasibility check', () => {
    const w = src('src/tester/workers.ts');
    expect(w.slice(w.indexOf('const finalize = async'), w.indexOf('const recoverLog'))).toContain('answerBy');
    const commit = w.slice(w.indexOf('export const commitBatch = guard'), w.indexOf('const runId'));
    expect(commit).toMatch(/candidateTicks\(\{[^}]*answerBy/);
  });
});

describe('B23-05 a posted release that differs from the database is reported', () => {
  test('postReleases compares the chain root and count with the tick it recomputes', () => {
    const w = src('src/tester/workers.ts');
    const post = w.slice(w.indexOf('export const postReleases'), w.indexOf('const deliveryFor'));
    expect(post).toMatch(/onChain\.root !== root \|\| onChain\.count !== t\.ids\.length/);
    expect(post).toContain("releaseLog.error('posted release differs from the tick in the database'");
  });
});

describe('B23-06 the tester headroom keeps the contract flush margin', () => {
  test('writeHeadroom is floatHeadroom minus 2,000 bytes, and is 0 exactly where assert_float starts refusing', async () => {
    const { floatHeadroom, writeHeadroom } = await import('../src/lib/near/shop.ts');
    const NEAR = 10n ** 24n;
    const margin = 2_000n * 10n ** 19n;
    expect(writeHeadroom(3n * NEAR, 50_000, NEAR / 2n)).toBe(floatHeadroom(3n * NEAR, 50_000, NEAR / 2n) - margin);
    // balance == storage + float + margin: the last write that assert_float accepts
    expect(writeHeadroom(50_000n * 10n ** 19n + NEAR / 2n + margin, 50_000, NEAR / 2n)).toBe(0n);
  });

  test('tester startup warns from writeHeadroom and says why it counts open slots in the database', () => {
    const t = src('tester.ts');
    expect(t).toContain('writeHeadroom(');
    expect(t).not.toContain('floatHeadroom(');
    expect(t).toContain('get_status has no open_slots view');
  });
});

describe('B23-07 real release history excludes tests by their on-chain expiry', () => {
  test('the exclusion window comes from each slot expiry (commit + test_ttl), not a fixed 3 days', () => {
    const w = src('src/tester/workers.ts');
    const fn = w.slice(w.indexOf('const realReleaseHistory'), w.indexOf('const finalize = async'));
    expect(fn).toContain('expiresAt: { gte: since }');
    expect(fn).not.toContain('3 * DAY_MS');
    expect(fn).not.toContain('createdAt');
  });
});

describe('B23-09 a second finalize of the same batch is a no-op that still records the signer', () => {
  const chain = { batch: 4, commitment: 'c', committed_at: '0', expires_at: '1800000000000000000', status: 'Committed', contained: false, reveal: null, tlock_round: 1, ciphertext_sha256: '0'.repeat(64) } as never;
  const sealed = (id: string) => ({ invoiceId: id, invoice: { document: { n: id }, email: { from_email: 'a@b.example' } } }) as never;

  // Postgres semantics: the conditional update claims a Prepared row once; later claims match nothing
  const fakeTx = (state: Map<string, string>) => {
    const calls = { invoices: [] as string[], slots: 0, batches: [] as unknown[] };
    const tx = {
      sealedSlot: {
        updateMany: async ({ where }: { where: { id: string; status: string } }) => {
          if (state.get(where.id) !== where.status) return { count: 0 };
          state.set(where.id, 'Committed');
          return { count: 1 };
        },
      },
      invoice: { create: async ({ data }: { data: { invoiceId: string } }) => calls.invoices.push(data.invoiceId) },
      testSlot: { upsert: async () => calls.slots++ },
      testBatch: { upsert: async (a: unknown) => calls.batches.push(a) },
    };
    return { tx: tx as never, calls };
  };

  test('recovery wins, then commitBatch: one delivery per lure, the loser claims nothing and records the signer', async () => {
    const { finalizeInTx } = await import('../src/tester/finalize.ts');
    const state = new Map([['r1', 'Prepared'], ['r2', 'Prepared']]);
    const items = [
      { rowId: 'r1', slotIndex: 10, chain, s: sealed('a'.repeat(64)) },
      { rowId: 'r2', slotIndex: 11, chain, s: sealed('b'.repeat(64)) },
    ];
    const common = { cid: 'c1', items, times: [new Date(1), new Date(2)], batchIndex: 4, expiresAt: new Date(3) };
    const first = fakeTx(state);
    expect(await finalizeInTx(first.tx, { ...common, batchTx: null })).toBe(2);
    expect(first.calls.invoices.length).toBe(2);
    const second = fakeTx(state);
    expect(await finalizeInTx(second.tx, { ...common, batchTx: { txHash: 'H', signerId: 'owner.testnet' } })).toBe(0);
    expect(second.calls.invoices).toEqual([]);
    expect(second.calls.slots).toBe(0);
    expect(JSON.stringify(second.calls.batches)).toContain('"signerId":"owner.testnet"');
  });

  test('finalize claims each row before any insert, so the loser never hits the unique invoice id', () => {
    const f = src('src/tester/finalize.ts');
    expect(f.indexOf("where: { id: o.rowId, status: 'Prepared' }")).toBeLessThan(f.indexOf('tx.invoice.create'));
    expect(f).toContain('if (won.count === 0) continue;');
    expect(src('src/tester/workers.ts')).toContain('finalizeInTx(tx,');
  });
});

describe('B23-10 an Ignored event never records the prove_delivery tx as the reveal tx', () => {
  test('a later-block Ignored event keeps the chain reveal time and leaves the reveal tx unknown', async () => {
    const { revealFields } = await import('../src/lib/near/revealFields.ts');
    const revealNs = '1794297600123456789';
    const revealMs = new Date(1794297600123);
    expect(revealFields({ txHash: 'PROVE', blockTime: new Date(revealMs.getTime() + 600_000) }, revealNs)).toEqual({ revealTxHash: null, revealedAt: revealMs });
    // reveal(.., delivery) itself emits Ignored in the reveal block: that tx is the reveal tx
    expect(revealFields({ txHash: 'REVEAL', blockTime: revealMs }, revealNs)).toEqual({ revealTxHash: 'REVEAL', revealedAt: revealMs });
    expect(revealFields({ txHash: 'T', blockTime: revealMs }, null)).toEqual({ revealTxHash: 'T', revealedAt: revealMs });
  });

  test('the projector routes Ignored first projections through revealFields with the chain reveal time', () => {
    const a = src('src/lib/near/applyEvent.ts');
    expect(a).toContain("revealFields(ev, d.status === 'Ignored' ? (chainReveal?.at ?? null) : null)");
    expect(a).not.toContain('revealTxHash: ev.txHash');
  });
});
