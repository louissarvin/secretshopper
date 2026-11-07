/**
 * B1 test set (16a §5.3): generates the "test" half of the blind corpus through the real tester generator,
 * the same way the commit worker does (vendor style set, sampled amount, fresh payee, real-intake normaliser).
 * Every NEAR AI call, kept or discarded, is saved with its receipt and attestation. Needs Bun >= 1.4.4.
 * Usage: bun --env-file=../backend/.env.tester b1-generate.ts
 * Env: NEARAI_API_KEY_TESTER, NEARAI_BASE_URL, GENERATOR_MODELS (default: the tester's DEFAULT_GENERATOR_MODELS),
 *      B1_N (default: size of the real set), B1_SEED (vendor and category assignment, default "b1"),
 *      B1_MAX_PER_PAYMENT (USDC cap fed to sampleAmount, default 100000), TEST_ETH_PAYEE_PERCENT (default 50),
 *      B1_CONCURRENCY (default 3), B1_MAX_CALLS (stop starting items once this many signed calls ran, default 3 x B1_N),
 *      B1_REAL, B1_VENDORS, B1_TESTS_OUT, B1_GEN_RECEIPTS_OUT, B1_RESUME=1 (keep items and receipts already in the outputs).
 * Both outputs are rewritten after every item, so a killed run keeps what it paid for.
 * Email samples: the vendor's R1 emails from the real set (its R2 email when it has no R1), approved payees redacted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createVerifiedChat } from '../backend/src/tester/nearai.ts';
import { CATEGORIES, DEFAULT_GENERATOR_MODELS, buildGeneratorInput, createGenerator, type Category, type GenerationAttempt } from '../backend/src/tester/generator.ts';
import { sampleAmount, vendorAmounts } from '../backend/src/tester/amounts.ts';
import { newTestPayee } from '../backend/src/tester/payees.ts';
import { checkReceipt } from '../backend/src/tester/receipt.ts';
import { verifyReceiptAgainstAttestation } from '../backend/src/lib/proof/attestation.ts';
import { normaliseIntake } from '../backend/src/utils/intake.ts';
import { req } from './lib/net.ts';

const DECIMALS = 6;
const realPath = process.env.B1_REAL || join(import.meta.dir, 'fixtures', 'b1-real.json');
const vendorsPath = process.env.B1_VENDORS || join(import.meta.dir, 'fixtures', 'b1-vendors.json');
const testsOut = process.env.B1_TESTS_OUT || join(import.meta.dir, 'fixtures', 'b1-tests.json');
const receiptsOut = process.env.B1_GEN_RECEIPTS_OUT || join(import.meta.dir, 'out', 'b1-generate-receipts.json');

type VendorView = { id: string; legalName: string; contactEmail: string; approved_payees: { account_id: string }[] };
type Master = { get_vendor: VendorView; create_body: { styleSet: unknown[] } };
type RealItem = { set: 'R1' | 'R2' | 'R3'; vendor: { id: string }; invoice: { bill_to: string }; email: { from_name: string; from_email: string; subject: string; body: string } };

const real = JSON.parse(readFileSync(realPath, 'utf8')) as RealItem[];
const master = JSON.parse(readFileSync(vendorsPath, 'utf8')) as Master[];
const byId = new Map(master.map((m) => [m.get_vendor.id, m]));

const N = Number(process.env.B1_N ?? real.length);
const concurrency = Number(process.env.B1_CONCURRENCY ?? 3);
const ethPercent = Number(process.env.TEST_ETH_PAYEE_PERCENT ?? 50);
const maxPerPayment = BigInt(Math.round(Number(process.env.B1_MAX_PER_PAYMENT ?? 100_000) * 10 ** DECIMALS));
const maxCalls = Number(process.env.B1_MAX_CALLS ?? 3 * N);
if (![N, concurrency, maxCalls].every((v) => Number.isInteger(v) && v >= 1)) throw new Error('B1_N, B1_CONCURRENCY and B1_MAX_CALLS must be positive integers');

// mulberry32: reproducible vendor and category assignment; payees stay cryptographically random
let state = [...(process.env.B1_SEED ?? 'b1')].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
const rand = (): number => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const shuffle = <T>(a: T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

// Vendors follow the real set's distribution so vendor identity carries no signal; categories rotate evenly.
const vendorOrder = shuffle(real.map((r) => r.vendor.id));
const categoryOrder = shuffle(Array.from({ length: N }, (_, i) => CATEGORIES[i % CATEGORIES.length]));
const company = real[0]?.invoice.bill_to ?? 'Larkspur Analytics Pte Ltd';
const models = process.env.GENERATOR_MODELS ? process.env.GENERATOR_MODELS.split(',').map((m) => m.trim()).filter(Boolean) : DEFAULT_GENERATOR_MODELS;

const chat = createVerifiedChat({ apiKey: req('NEARAI_API_KEY_TESTER'), baseUrl: process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1' });
const generate = createGenerator(chat, models);

// Real mail from the vendor itself (never R3, which is fraud); the vendor's own payee becomes <account> like SYNTHETIC_STYLE.
const emailSamplesFor = (m: Master): unknown[] => {
  const own = real.filter((r) => r.vendor.id === m.get_vendor.id);
  const picked = own.filter((r) => r.set === 'R1').length > 0 ? own.filter((r) => r.set === 'R1') : own.filter((r) => r.set === 'R2');
  const redact = (t: string) => m.get_vendor.approved_payees.reduce((acc, p) => acc.split(p.account_id).join('<account>'), t);
  return picked.slice(0, 3).map((r) => ({ ...r.email, subject: redact(r.email.subject), body: redact(r.email.body) }));
};

const items: unknown[] = new Array(N);
const attempts: (Omit<GenerationAttempt, 'receipt'> & GenerationAttempt['receipt'] & { itemId: string; category: Category })[] = [];
const failures: { itemId: string; error: string }[] = [];

// vendor and category order come from the seed, so a resumed run assigns the same item ids the same way
if (process.env.B1_RESUME === '1' && existsSync(testsOut)) {
  for (const it of JSON.parse(readFileSync(testsOut, 'utf8')) as { id: string }[]) items[Number(it.id.slice(2)) - 1] = it;
  if (existsSync(receiptsOut)) attempts.push(...(JSON.parse(readFileSync(receiptsOut, 'utf8')) as typeof attempts));
}
const save = (): void => {
  mkdirSync(dirname(testsOut), { recursive: true });
  mkdirSync(dirname(receiptsOut), { recursive: true });
  writeFileSync(testsOut, JSON.stringify(items.filter(Boolean), null, 2) + '\n');
  writeFileSync(receiptsOut, JSON.stringify(attempts, null, 2) + '\n');
};

const one = async (i: number): Promise<void> => {
  const itemId = `T-${String(i + 1).padStart(2, '0')}`;
  const m = byId.get(vendorOrder[i % vendorOrder.length]);
  if (!m) throw new Error(`vendor ${vendorOrder[i % vendorOrder.length]} missing from vendor master`);
  const category = categoryOrder[i];
  const payee = newTestPayee(ethPercent);
  const amount = sampleAmount(vendorAmounts([], m.create_body.styleSet, DECIMALS), maxPerPayment, DECIMALS);
  try {
    const { draft, receipt } = await generate(
      buildGeneratorInput({ company, category, vendor: { ...m.get_vendor, styleSet: m.create_body.styleSet }, payee: payee.payee, amount, emailSamples: emailSamplesFor(m), maxTotal: String(Number(maxPerPayment) / 10 ** DECIMALS) }),
      ({ receipt: r, ...rest }) => void attempts.push({ ...rest, ...r, itemId, category })
    );
    // same vendor_id rule and normaliser as the commit worker
    const { document, email } = normaliseIntake({ document: { ...draft.invoice, vendor_id: m.get_vendor.id }, email: draft.email });
    // `set` and `source` are stripped by b1-blind.ts before the judge sees anything, like the real items' fields
    items[i] = {
      id: itemId,
      label: 'test',
      set: 'T',
      source: { generator_model: receipt.model, category, target_amount: amount, amount: document.total, payee_kind: payee.kind, response_id: receipt.responseId },
      vendor: m.get_vendor,
      chain: { account_id: payee.payee, exists: false, has_contract: false },
      invoice: document,
      email,
    };
    save();
    process.stderr.write(`${itemId} ${category} ok (${receipt.model}), ${attempts.length} calls\n`);
  } catch (e) {
    failures.push({ itemId, error: (e as Error).message.slice(0, 200) });
    save();
    process.stderr.write(`${itemId} ${category} failed: ${(e as Error).message.slice(0, 200)}\n`);
  }
};

let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, N) }, async () => {
  while (next < N && attempts.length < maxCalls) {
    const i = next++;
    if (!items[i]) await one(i);
  }
}));

const kept = items.filter(Boolean);
const verified = attempts.map((a) => ({ bytes: checkReceipt(a).ok, assurance: verifyReceiptAgainstAttestation(a, a.attestation).assurance }));
save();

const count = (xs: string[]) => xs.reduce<Record<string, number>>((o, x) => ((o[x] = (o[x] ?? 0) + 1), o), {});
console.log(
  JSON.stringify(
    {
      requested: N,
      generated: kept.length,
      failures,
      models_tried: models,
      accepted_by_model: count(attempts.filter((a) => a.accepted).map((a) => a.model)),
      calls_with_receipt: attempts.length,
      rejected_drafts: attempts.filter((a) => !a.accepted).length,
      receipts_bytes_ok: verified.filter((v) => v.bytes).length,
      assurance: count(verified.map((v) => String(v.assurance))),
      tests: testsOut,
      receipts: receiptsOut,
    },
    null,
    2
  )
);
if (kept.length < N) process.exit(1);
