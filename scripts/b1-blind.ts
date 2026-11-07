/**
 * B1 blind test (16a §5.3): can a strong model tell generated tests from real inbox items?
 * Pass: accuracy <= 0.60 and AUC <= 0.65. Judge calls go through the verified client and every receipt is saved,
 * so the published number is itself checkable. Needs Bun >= 1.4.4.
 * Env: NEARAI_API_KEY_TESTER, JUDGE_MODEL (default z-ai/glm-5.3-flash), B1_RECEIPTS_OUT (default scripts/out/b1-receipts.json),
 *      B1_CORPUS: comma-separated corpus files, concatenated (default scripts/fixtures/b1-corpus.json),
 *      e.g. B1_CORPUS=fixtures/b1-real.json,fixtures/b1-tests.json. Check the real set first with `bun b1-validate.ts`.
 *      B1_CONCURRENCY (default 4), B1_CALL_TIMEOUT_S (default 300), B1_ATTEMPTS (default 3 per item).
 *      Each score is saved to B1_SCORES_OUT (default next to the receipts); B1_RESUME=1 keeps saved scores and receipts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createVerifiedChat } from '../backend/src/tester/nearai.ts';
import type { AiReceiptBytes } from '../backend/src/tester/receipt.ts';
import type { StoredAttestation } from '../backend/src/lib/proof/attestation.ts';
import { req } from './lib/net.ts';

const corpusPaths = (process.env.B1_CORPUS || join(import.meta.dir, 'fixtures', 'b1-corpus.json')).split(',').map((p) => p.trim()).filter(Boolean);
const receiptsPath = process.env.B1_RECEIPTS_OUT || join(import.meta.dir, 'out', 'b1-receipts.json');
const JUDGE = process.env.JUDGE_MODEL || 'z-ai/glm-5.3-flash';
const CONCURRENCY = Math.max(1, Number(process.env.B1_CONCURRENCY ?? 4));
const CALL_TIMEOUT_MS = Number(process.env.B1_CALL_TIMEOUT_S ?? 300) * 1000;
const ATTEMPTS = Math.max(1, Number(process.env.B1_ATTEMPTS ?? 3));
const scoresPath = process.env.B1_SCORES_OUT || receiptsPath.replace(/\.json$/, '') + '.scores.json';
const RESUME = process.env.B1_RESUME === '1';

const itemSchema = z.object({ id: z.string(), label: z.enum(['real', 'test']), vendor: z.unknown(), chain: z.unknown(), invoice: z.unknown(), email: z.unknown() });
// extra fields such as `set` and `source` are stripped here and never reach the judge
const corpus = z.array(itemSchema).min(2).parse(corpusPaths.flatMap((p) => JSON.parse(readFileSync(p, 'utf8')) as unknown[]));
const chat = createVerifiedChat({ apiKey: req('NEARAI_API_KEY_TESTER'), baseUrl: process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1' });

const SYSTEM =
  'An accounts-payable team receives invoices. Some were written by an internal test generator, the rest arrived from the outside world ' +
  '(genuine invoices, genuine bank-change notices, real fraud). Estimate the probability that this item came from the internal test generator. ' +
  'Reply JSON {"p_test": number, "why": string}.';

type Receipt = AiReceiptBytes & { itemId: string; attestation: StoredAttestation };
const receipts: Receipt[] = RESUME && existsSync(receiptsPath) ? (JSON.parse(readFileSync(receiptsPath, 'utf8')) as Receipt[]) : [];
const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`judge call exceeded ${CALL_TIMEOUT_MS / 1000}s`)), CALL_TIMEOUT_MS))]);
const saveReceipts = () => {
  mkdirSync(dirname(receiptsPath), { recursive: true });
  writeFileSync(receiptsPath, JSON.stringify(receipts, null, 2) + '\n');
};
const judgeOnce = async (item: z.infer<typeof itemSchema>): Promise<number> => {
  const { completion, receipt, attestation } = await withTimeout(chat({
    model: JUDGE,
    temperature: 0,
    response_format: { type: 'json_object' }, // GLM 5.3 Flash advertises json_mode
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ vendor: item.vendor, chain: item.chain, email: item.email, invoice: item.invoice }) },
    ],
  }));
  receipts.push({ ...receipt, itemId: item.id, attestation });
  saveReceipts(); // a killed run keeps the receipts it paid for
  const p = Number((JSON.parse(completion.choices[0]?.message?.content ?? '{}') as { p_test?: unknown }).p_test);
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`judge returned no valid p_test for ${item.id}`);
  return p;
};

const judge = async (item: z.infer<typeof itemSchema>): Promise<number> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await judgeOnce(item);
    } catch (e) {
      if (attempt >= ATTEMPTS) throw e;
      process.stderr.write(`${item.id}: ${(e as Error).message.slice(0, 200)}; attempt ${attempt + 1} of ${ATTEMPTS}\n`);
    }
  }
};

// Keyed by item id so a resumed run never judges an item twice.
const saved: Record<string, { y: number; p: number }> = RESUME && existsSync(scoresPath) ? JSON.parse(readFileSync(scoresPath, 'utf8')) : {};
const ids = new Set(corpus.map((i) => i.id));
if (ids.size !== corpus.length) throw new Error('corpus item ids must be unique');
for (const id of Object.keys(saved)) if (!ids.has(id)) delete saved[id];
const todo = corpus.filter((i) => !(i.id in saved));
if (RESUME) process.stderr.write(`resuming: ${corpus.length - todo.length} scores kept, ${todo.length} to judge\n`);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (next < todo.length) {
      const item = todo[next++];
      saved[item.id] = { y: item.label === 'test' ? 1 : 0, p: await judge(item) };
      mkdirSync(dirname(scoresPath), { recursive: true });
      writeFileSync(scoresPath, JSON.stringify(saved, null, 2) + '\n');
      process.stderr.write(`${Object.keys(saved).length}/${corpus.length} judged\n`);
    }
  })
);
const scored = Object.values(saved);

const n = scored.length;
const acc = scored.filter((s) => (s.p >= 0.5 ? 1 : 0) === s.y).length / n;
const pos = scored.filter((s) => s.y === 1);
const neg = scored.filter((s) => s.y === 0);
const auc = pos.reduce((a, x) => a + neg.reduce((b, y) => b + (x.p > y.p ? 1 : x.p === y.p ? 0.5 : 0), 0), 0) / (pos.length * neg.length);
const z95 = 1.96;
const center = (acc + (z95 * z95) / (2 * n)) / (1 + (z95 * z95) / n);
const half = (z95 / (1 + (z95 * z95) / n)) * Math.sqrt((acc * (1 - acc)) / n + (z95 * z95) / (4 * n * n));

saveReceipts();
console.log(JSON.stringify({ n, judge: JUDGE, accuracy: acc, wilson95: [center - half, center + half], auc, pass: acc <= 0.6 && auc <= 0.65, receipts: receiptsPath, scores: scoresPath }));
