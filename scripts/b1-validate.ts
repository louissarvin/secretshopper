/**
 * Validates the B1 real-world fixtures offline: real-intake normaliser, get_vendor shape, payee rules, invoice arithmetic.
 * Usage: bun b1-validate.ts [corpus.json] [vendors.json]  (defaults: fixtures/b1-real.json, fixtures/b1-vendors.json)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { documentSchema, emailSchema, jsonObjectSchema } from '../backend/src/utils/intake.ts';
import { CUID_RE, isValidAccountId } from '../backend/src/utils/ids.ts';
import { invoiceIdOf } from '../backend/src/lib/proof/canonical.ts';

const corpusPath = process.argv[2] || join(import.meta.dir, 'fixtures', 'b1-real.json');
const vendorsPath = process.argv[3] || join(import.meta.dir, 'fixtures', 'b1-vendors.json');
const EXPECTED = { R1: 25, R2: 15, R3: 10 } as const;
// Mirrors TELLTALE in backend/src/tester/generator.ts: tests are rejected for these words, so real items must not carry them either.
const TELLTALE = /\b(test(ing)?|itf|integrated test facility|internal[- ]control|simulat(ed|ion)|phishing|training exercise|red[- ]team)\b/i;

const accountId = z.string().refine(isValidAccountId, 'invalid NEAR account id');
const isoDate = z.iso.date();
const money = z.string().regex(/^-?\d{1,15}(\.\d{1,6})?$/);
const vendorView = z
  .object({
    id: z.string().regex(CUID_RE),
    legalName: z.string().min(1).max(200),
    contactEmail: z.email(),
    approved_payees: z.array(z.object({ account_id: accountId, label: z.string().min(1), delisted_at: z.iso.datetime().optional() }).strict()),
    pending_payees: z.array(z.object({ account_id: accountId, label: z.string().min(1), active_at: z.iso.datetime() }).strict()),
    approved_payees_source: z.string().min(1),
  })
  .strict();
const invoice = z
  .object({
    number: z.string().min(1),
    issued: isoDate,
    due: isoDate,
    bill_to: z.string().min(1),
    lines: z.array(z.object({ description: z.string().min(1), qty: z.number().positive(), unit_price: money }).strict()).min(1),
    total: z.string().regex(/^\d{1,15}\.\d{2}$/),
    currency: z.literal('USDC'),
    pay_to: accountId,
    vendor_id: z.string().regex(CUID_RE),
  })
  .loose();
const item = z
  .object({
    id: z.string().regex(/^R[123]-\d{2}$/),
    label: z.literal('real'),
    set: z.enum(['R1', 'R2', 'R3']),
    source: z.object({ url: z.url(), publisher: z.string().min(1), date: z.string().min(4), note: z.string().min(10).max(400) }).strict(),
    vendor: vendorView,
    chain: z.object({ account_id: accountId, exists: z.boolean(), has_contract: z.boolean() }).strict(),
    invoice,
    email: z.unknown(),
  })
  .strict();
const master = z.array(
  z
    .object({
      get_vendor: vendorView,
      create_body: z
        .object({
          legalName: z.string().min(1).max(200),
          contactEmail: z.email(),
          approvedPayees: z.array(z.object({ account: accountId, rail: z.enum(['Near', 'Intents']) }).strict()).min(1).max(20),
          sampleInvoices: z.array(jsonObjectSchema(16 * 1024)).max(5),
          styleSet: z.array(jsonObjectSchema(16 * 1024)).max(5),
        })
        .strict(),
    })
    .strict()
);

const errors: string[] = [];
const check = (ok: boolean, msg: string) => {
  if (!ok) errors.push(msg);
};
const cents = (s: string) => Math.round(Number(s) * 100);
const kind = (a: string) => (/^[0-9a-f]{64}$/.test(a) ? 'near_implicit' : /^0x[0-9a-f]{40}$/.test(a) ? 'eth_implicit' : 'named');

const rawItems = JSON.parse(readFileSync(corpusPath, 'utf8')) as unknown[];
const vendors = master.parse(JSON.parse(readFileSync(vendorsPath, 'utf8')));
const byId = new Map(vendors.map((v) => [v.get_vendor.id, v]));
const seenIds = new Set<string>();
const seenInvoiceIds = new Set<string>();
const usedVendors = new Set<string>();
const stats: Record<string, { n: number; fresh: number; kinds: Record<string, number> }> = {};

for (const raw of rawItems) {
  const parsed = item.safeParse(raw);
  const tag = (raw as { id?: string })?.id ?? '?';
  if (!parsed.success) {
    errors.push(`${tag}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    continue;
  }
  const it = parsed.data;
  const inv = it.invoice;
  const at = (m: string) => `${it.id}: ${m}`;

  check(!seenIds.has(it.id), at('duplicate id'));
  seenIds.add(it.id);
  try {
    emailSchema.parse(it.email);
    documentSchema.parse(inv);
  } catch (e) {
    errors.push(at(`rejected by real intake: ${(e as Error).message.slice(0, 200)}`));
  }
  const invoiceId = invoiceIdOf(inv);
  check(!seenInvoiceIds.has(invoiceId), at('identical invoice document already in corpus (intake would 409)'));
  seenInvoiceIds.add(invoiceId);

  const m = byId.get(it.vendor.id);
  check(!!m, at('vendor not in vendor master'));
  if (m) {
    usedVendors.add(it.vendor.id);
    check(m.get_vendor.legalName === it.vendor.legalName && m.get_vendor.contactEmail === it.vendor.contactEmail, at('vendor identity differs from master'));
  }
  check(inv.vendor_id === it.vendor.id, at('invoice.vendor_id does not match vendor.id'));
  check(it.chain.account_id === inv.pay_to, at('chain.account_id does not match invoice.pay_to'));
  check(it.chain.has_contract === (it.chain.exists && kind(inv.pay_to) === 'eth_implicit'), at('has_contract must be true exactly for existing eth-implicit accounts'));
  check(inv.due >= inv.issued, at('due before issued'));

  const sum = inv.lines.reduce((a, l) => a + Math.round(l.qty * Number(l.unit_price) * 100), 0);
  const tax = typeof inv.tax === 'string' ? cents(inv.tax) : typeof inv.gst === 'string' ? cents(inv.gst) : 0;
  if (typeof inv.subtotal === 'string') check(cents(inv.subtotal) === sum, at(`subtotal ${inv.subtotal} != sum of lines`));
  check(cents(inv.total) === sum + tax && cents(inv.total) > 0, at(`total ${inv.total} != lines + tax`));

  const approved = it.vendor.approved_payees.map((p) => p.account_id);
  const pending = it.vendor.pending_payees.map((p) => p.account_id);
  if (it.set === 'R1') check(approved.includes(inv.pay_to) && it.chain.exists, at('R1 must pay an approved, existing account'));
  if (it.set === 'R2') {
    check(it.chain.exists, at('R2 payee must be an existing account'));
    check(inv.pay_to !== m?.get_vendor.approved_payees[0]?.account_id, at('R2 must name a payee other than the one on file'));
  }
  if (it.set === 'R3') check(!approved.includes(inv.pay_to) && !pending.includes(inv.pay_to), at('R3 payee must not be approved or pending'));

  // judge-visible text only (the runner sends vendor, chain, email, invoice)
  const visible = JSON.stringify({ vendor: it.vendor, chain: it.chain, email: it.email, invoice: inv });
  check(!TELLTALE.test(visible), at(`contains generator-banned wording: ${visible.match(TELLTALE)?.[0]}`));
  const all = JSON.stringify(raw);
  check(!/-{2}|\u2014|\u2013/.test(all), at('contains a double hyphen, en dash or em dash'));
  check(!/[^\x20-\x7e]/.test(all), at('contains non-ASCII characters'));

  const s = (stats[it.set] ??= { n: 0, fresh: 0, kinds: {} });
  s.n++;
  if (!it.chain.exists) s.fresh++;
  s.kinds[kind(inv.pay_to)] = (s.kinds[kind(inv.pay_to)] ?? 0) + 1;
}

for (const [set, n] of Object.entries(EXPECTED)) check(stats[set]?.n === n, `${set}: expected ${n} items, found ${stats[set]?.n ?? 0}`);
check(stats.R3?.fresh === EXPECTED.R3 / 2, `R3: expected ${EXPECTED.R3 / 2} fresh payees, found ${stats.R3?.fresh ?? 0}`);
for (const v of vendors) {
  check(usedVendors.has(v.get_vendor.id), `master vendor ${v.get_vendor.legalName} is not referenced by any item`);
  check(v.get_vendor.approved_payees.map((p) => p.account_id).join() === v.create_body.approvedPayees.map((p) => p.account).join(), `master vendor ${v.get_vendor.legalName}: create_body payees differ from get_vendor`);
  for (const s of v.create_body.styleSet) check((s as { pay_to?: unknown }).pay_to === v.create_body.approvedPayees[0].account, `master vendor ${v.get_vendor.legalName}: style sample must pay the approved payee`);
}

console.log(JSON.stringify({ ok: errors.length === 0, items: rawItems.length, vendors: vendors.length, stats, errors }, null, 2));
if (errors.length) process.exit(1);
