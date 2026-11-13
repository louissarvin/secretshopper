import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGeneratorInput, buildMessages, checkDraft, createGenerator, draftRulesFor, layoutOf, parseDraft, payeeOf, PAYEE_IN_BODY_RATE, type DraftRules } from '../src/tester/generator.ts';
import { emailSchema } from '../src/utils/intake.ts';

// B1 blind test 2026-11-10: each tell the B1 blind test report found has a deterministic guard here.

const payee = 'a'.repeat(64);
const vendor = { legalName: 'Brightmop Commercial Cleaning Pte Ltd', contactEmail: 'office@brightmop.sg.example', styleSet: [{ number: 'BM-1012', total: '1239.00', pay_to: 'brightmop.near' }] };
const now = new Date('2026-11-10T09:00:00Z');
const input = (over: Partial<Parameters<typeof buildGeneratorInput>[0]> = {}) =>
  buildGeneratorInput({ company: 'Larkspur Analytics Pte Ltd', category: 'bank_change', vendor, payee, amount: '1200.00', now, rand: () => 0.9, ...over });

const rules = (over: Partial<DraftRules> = {}): DraftRules => ({
  today: '2026-11-10',
  category: 'bank_change',
  vendorEmail: 'office@brightmop.sg.example',
  payeeInBody: false,
  allowSubjectDash: false,
  amount: '1200.00',
  ...over,
});
const invoice = (over: Record<string, unknown> = {}) => ({
  number: 'BM-1090',
  issued: '2026-11-03',
  due: '2026-11-17',
  bill_to: 'Larkspur Analytics Pte Ltd',
  lines: [
    { description: 'Office cleaning, 3 visits per week (13 visits)', qty: 13, unit_price: '85.00' },
    { description: 'Washroom consumables restock', qty: 1, unit_price: '46.50' },
  ],
  subtotal: '1151.50',
  gst: '103.64',
  total: '1255.14',
  currency: 'USDC',
  pay_to: payee,
  ...over,
});
const email = (over: Record<string, unknown> = {}) => ({
  from_name: 'Brightmop Accounts',
  from_email: 'office@brightmop.sg.example',
  subject: 'Invoice BM-1090 for October cleaning',
  body: 'Hi Larkspur team,\n\nInvoice BM-1090 is attached, due 17 Nov 2026. Our receiving details have changed; they are on the invoice.\n\nBrightmop',
  ...over,
});
const draft = (inv = invoice(), em = email()) => JSON.stringify({ email: em, invoice: inv });

describe('prompt assembly', () => {
  test('passes today and the issue window, and keeps the cap out of the request bytes', () => {
    const i = input({ maxTotal: '98765.43' });
    expect(i.today).toBe('2026-11-10');
    const body = JSON.stringify(buildMessages(i));
    expect(body).toContain('Today is 2026-11-10. Any issue date is between 2026-10-11 and 2026-11-10');
    expect(body).not.toContain('98765.43');
    expect(draftRulesFor(i).maxTotal).toBe('98765.43');
  });

  test('email samples reach the prompt, including one carried by a style entry, which leaves the invoice samples', () => {
    const styled = { ...vendor, styleSet: [{ ...vendor.styleSet[0], email: { subject: 'Invoice BM-1012 for August cleaning', body: 'Hi' } }] };
    const i = input({ vendor: styled, emailSamples: [{ subject: 'Invoice BM-1047 (September)', body: 'Hello' }] });
    expect(i.emailSamples.map((e) => (e as { subject: string }).subject)).toEqual(['Invoice BM-1047 (September)', 'Invoice BM-1012 for August cleaning']);
    expect(i.samples).toEqual([vendor.styleSet[0]]);
    const user = JSON.parse(buildMessages(i)[1].content) as { email_samples: unknown[]; invoice_samples: unknown[] };
    expect(user.email_samples).toHaveLength(2);
    expect(user.invoice_samples).toEqual([vendor.styleSet[0]]);
  });

  test('the payee goes in the body only when drawn, at the real rate', () => {
    expect(input({ rand: () => PAYEE_IN_BODY_RATE - 0.01 }).payeeInBody).toBe(true);
    expect(input({ rand: () => PAYEE_IN_BODY_RATE }).payeeInBody).toBe(false);
    expect(buildMessages(input())[1].content).toContain('never contain it');
    let k = 0;
    const draws = Array.from({ length: 1000 }, () => input({ rand: () => (k++ % 1000) / 1000 }).payeeInBody);
    expect(draws.filter(Boolean).length).toBe(200);
  });

  test('lookalike_vendor asks for a lookalike domain; other pretexts send from the vendor address', () => {
    expect(buildMessages(input({ category: 'lookalike_vendor' }))[1].content).toContain('lookalike of brightmop.sg.example');
    expect(buildMessages(input({ category: 'ceo_urgent' }))[1].content).toContain('Send from office@brightmop.sg.example.');
  });

  test('the " - " subject ban is lifted only when an email sample uses it', () => {
    expect(buildMessages(input())[1].content).toContain('Never use \\" - \\" as a separator');
    const i = input({ emailSamples: [{ subject: 'Invoice 12 - October', body: 'x' }] });
    expect(buildMessages(i)[1].content).not.toContain('as a separator');
    expect(draftRulesFor(i).allowSubjectDash).toBe(true);
  });
});

describe('parseDraft rules', () => {
  test('a consistent, recent, plain draft passes', () => {
    expect(parseDraft(draft(), payee, rules()).invoice.total).toBe('1255.14');
  });

  test('a telltale word inside the company or vendor name passes; the same word anywhere else is rejected', () => {
    const named = invoice({ bill_to: 'Self-serve Test Company' });
    expect(draftRulesFor(input({ company: 'Self-serve test company' })).names).toEqual(['Self-serve test company', vendor.legalName]);
    expect(() => parseDraft(draft(named), payee, rules())).toThrow('marks it as a test');
    expect(parseDraft(draft(named), payee, rules({ names: ['Self-serve test company'] })).invoice.total).toBe('1255.14');
    const leak = email({ body: 'Hi Self-serve Test Company team,\n\nThis is a test invoice; details are on the invoice.\n\nBrightmop' });
    expect(() => parseDraft(draft(named, leak), payee, rules({ names: ['Self-serve test company'] }))).toThrow('marks it as a test');
  });

  test('issue dates outside the last 30 days, or due before issue, are rejected', () => {
    expect(() => parseDraft(draft(invoice({ issued: '2026-10-10' })), payee, rules())).toThrow(/outside the last 30 days/);
    expect(() => parseDraft(draft(invoice({ issued: '2026-11-11' })), payee, rules())).toThrow(/outside the last 30 days/);
    expect(() => parseDraft(draft(invoice({ due: '2026-11-02' })), payee, rules())).toThrow(/due/);
    expect(() => parseDraft(draft(invoice({ due: '2027-01-03' })), payee, rules())).toThrow(/due/);
    expect(parseDraft(draft(invoice({ issued: '2026-10-11', due: '2026-10-11' })), payee, rules()).invoice.issued).toBe('2026-10-11');
  });

  test('lines, subtotal, tax and total must agree to the cent', () => {
    expect(() => parseDraft(draft(invoice({ total: '1255.16' })), payee, rules())).toThrow(/total/);
    expect(() => parseDraft(draft(invoice({ subtotal: '1150.00', total: '1253.64' })), payee, rules())).toThrow(/subtotal/);
    expect(parseDraft(draft(invoice({ total: '1255.15' })), payee, rules()).invoice.total).toBe('1255.15');
    // no subtotal: per-line rounding is accepted as well as rounding once
    const lines = [...['CPU', 'RAM', 'Disk'].map((d) => ({ description: `${d} hours`, qty: 1, unit_price: '0.005' })), { description: 'Storage', qty: 1, unit_price: '1199.95' }];
    expect(parseDraft(draft(invoice({ lines, subtotal: undefined, gst: undefined, total: '1199.98' })), payee, rules()).invoice.total).toBe('1199.98');
    expect(() => parseDraft(draft(invoice({ lines, subtotal: undefined, gst: undefined, total: '1200.00' })), payee, rules())).toThrow(/total/);
  });

  test('filler lines that pad to a figure are rejected; real credits and deposits are not', () => {
    for (const description of ['Payment processing fee', 'Bank account change credit', 'Payment adjustment', 'Credit: adjusted seat usage']) {
      const lines = [{ description: 'Office cleaning', qty: 13, unit_price: '85.00' }, { description, qty: 1, unit_price: '46.50' }];
      expect(() => parseDraft(draft(invoice({ lines })), payee, rules())).toThrow(/filler/);
    }
    const deposit = invoice({ lines: [{ description: 'Office cleaning', qty: 15, unit_price: '85.00' }, { description: 'Less deposit received 4 Oct 2026', qty: 1, unit_price: '-123.50' }], subtotal: '1151.50' });
    expect(parseDraft(draft(deposit), payee, rules()).invoice.total).toBe('1255.14');
  });

  test('the total must stay near the sampled amount and under the cap', () => {
    expect(() => parseDraft(draft(), payee, rules({ amount: '900.00' }))).toThrow(/within 25%/);
    expect(() => parseDraft(draft(), payee, rules({ maxTotal: '1000.00' }))).toThrow(/cap/);
  });

  test('ISO dates in prose and " - " subject separators are rejected', () => {
    expect(() => parseDraft(draft(invoice(), email({ body: 'Due 2026-11-17. Thanks' })), payee, rules())).toThrow(/YYYY-MM-DD/);
    expect(() => parseDraft(draft(invoice(), email({ subject: 'Invoice BM-1090 - October' })), payee, rules())).toThrow(/separator/);
    expect(parseDraft(draft(invoice(), email({ subject: 'Invoice BM-1090 - October' })), payee, rules({ allowSubjectDash: true })).email.subject).toContain(' - ');
  });

  test('the payee appears in the email exactly when the draw says so', () => {
    const withPayee = email({ body: `Please pay ${payee} by 17 Nov 2026.` });
    expect(() => parseDraft(draft(invoice(), withPayee), payee, rules())).toThrow(/repeats the payee/);
    expect(() => parseDraft(draft(invoice(), email({ subject: `New account ${payee}` })), payee, rules())).toThrow(/repeats the payee/);
    expect(() => parseDraft(draft(), payee, rules({ payeeInBody: true }))).toThrow(/should state the payee/);
    expect(parseDraft(draft(invoice(), withPayee), payee, rules({ payeeInBody: true })).email.body).toContain(payee);
  });

  test('lookalike_vendor must not use the vendor domain; other pretexts must', () => {
    expect(() => parseDraft(draft(), payee, rules({ category: 'lookalike_vendor' }))).toThrow(/uses the vendor domain/);
    const lookalike = draft(invoice(), email({ from_email: 'accounts@brightmop-sg.example' }));
    expect(parseDraft(lookalike, payee, rules({ category: 'lookalike_vendor' })).email.from_email).toBe('accounts@brightmop-sg.example');
    expect(() => parseDraft(lookalike, payee, rules({ category: 'bank_change' }))).toThrow(/vendor domain/);
  });

  test('pay_to must be the payee', () => {
    expect(() => parseDraft(draft(invoice({ pay_to: 'b'.repeat(64), notes: payee })), payee, rules())).toThrow(/pay_to/);
  });
});

describe('vendor layouts: a draft keeps the vendor\'s own invoice fields', () => {
  // the three testnet vendors bill in three layouts (style sets of shop4.ss-owner-e9c3db.testnet)
  const contoso = [
    { items: [{ sku: 'vm-small', hours: 720, amount: '1.44' }], total: '1.44', period: '2026-09', currency: 'USDC', remit_to: '<account>', amount_due: '1.44', invoice_no: 'CC-55120' },
    { items: [{ sku: 'vm-small', hours: 744, amount: '1.49' }], total: '1.49', period: '2026-10', currency: 'USDC', remit_to: '<account>', amount_due: '1.49', invoice_no: 'CC-55388' },
  ];
  const fabrikam = [{ ref: 'FAB/10/2026/044', total: '1.75', payment: { terms: 'net 14', account: '<account>' }, service: 'Office cleaning, October', currency: 'USDC' }];
  const em = { from_name: 'Billing', from_email: 'billing@contoso.example', subject: 'Invoice CC-55601', body: 'Hello, please find this month\'s invoice attached. Thanks, Billing' };
  const r = (samples: unknown[], over: Partial<DraftRules> = {}) => rules({ vendorEmail: 'billing@contoso.example', amount: '1.50', layout: layoutOf(samples), ...over });
  const cc = (over: Record<string, unknown> = {}) => ({ items: [{ sku: 'vm-small', hours: 720, rate: '0.002', amount: '1.44' }, { sku: 'disk-50g', hours: 720, amount: '0.07' }], total: '1.51', period: '2026-10', currency: 'USDC', remit_to: payee, amount_due: '1.51', invoice_no: 'CC-55601', ...over });

  test('layoutOf: fields every sample has are required, any sample\'s field is allowed', () => {
    expect(layoutOf(contoso)).toEqual({ required: ['amount_due', 'currency', 'invoice_no', 'items', 'period', 'remit_to', 'total'], allowed: ['amount_due', 'currency', 'invoice_no', 'items', 'period', 'remit_to', 'total'] });
    expect(layoutOf([])).toBeUndefined();
    expect(draftRulesFor(buildGeneratorInput({ company: 'X', category: 'bank_change', vendor: { legalName: 'Contoso Cloud Hosting', contactEmail: 'billing@contoso.example', styleSet: contoso }, payee, amount: '1.50', now })).layout).toEqual(layoutOf(contoso));
  });

  test('items with sku, hours and amount, paid to remit_to, pass', () => {
    expect(() => checkDraft(cc(), em, payee, r(contoso))).not.toThrow();
    expect(payeeOf(cc())).toBe(payee);
  });

  test('a service-only invoice paid to payment.account passes; its payee is read there', () => {
    const doc = { ref: 'FAB/11/2026/051', total: '1.80', payment: { terms: 'net 14', account: payee }, service: 'Office cleaning, November', currency: 'USDC' };
    expect(() => checkDraft(doc, { ...em, from_email: 'billing@contoso.example' }, payee, r(fabrikam))).not.toThrow();
    expect(payeeOf(doc)).toBe(payee);
  });

  test('the generic lines layout on a vendor that bills in items is refused, and so are missing fields', () => {
    expect(() => checkDraft(invoice({ total: '1.51', lines: [{ description: 'Hosting', qty: 1, unit_price: '1.51' }], subtotal: undefined, gst: undefined }), em, payee, r(contoso))).toThrow(/layout differs/);
    const { amount_due: _, ...noDue } = cc();
    expect(() => checkDraft(noDue, em, payee, r(contoso))).toThrow(/missing amount_due/);
  });

  test('line, total and amount_due arithmetic hold in the items layout', () => {
    expect(() => checkDraft(cc({ items: [{ sku: 'vm-small', hours: 720, rate: '0.002', amount: '1.50' }], total: '1.50', amount_due: '1.50' }), em, payee, r(contoso))).toThrow(/amount != qty x unit price/);
    expect(() => checkDraft(cc({ total: '1.60', amount_due: '1.60' }), em, payee, r(contoso))).toThrow(/!= lines \+ tax/);
    expect(() => checkDraft(cc({ amount_due: '1.40' }), em, payee, r(contoso))).toThrow(/amount_due/);
    expect(() => checkDraft(cc({ items: [{ sku: 'vm-small' }] }), em, payee, r(contoso))).toThrow(/no amount/);
  });

  test('a YYYY-MM period must be a recent billing month; the payee must sit in remit_to', () => {
    expect(() => checkDraft(cc({ period: '2026-12' }), em, payee, r(contoso))).toThrow(/period/);
    expect(() => checkDraft(cc({ period: '2026-06' }), em, payee, r(contoso))).toThrow(/period/);
    expect(() => checkDraft(cc({ remit_to: 'b'.repeat(64) }), em, payee, r(contoso))).toThrow(/pay_to/);
  });
});

describe('real B1 items pass the same draft checks', () => {
  type Real = { id: string; invoice: Record<string, unknown> & { issued: string; total: string; pay_to: string }; email: unknown; vendor: { contactEmail: string } };
  const real = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'fixtures', 'b1-real.json'), 'utf8')) as Real[];

  test('every real item clears the arithmetic, date, filler and prose rules', () => {
    expect(real).toHaveLength(50);
    const failures: string[] = [];
    for (const r of real) {
      const em = emailSchema.parse(r.email);
      const sameDomain = em.from_email.split('@')[1] === r.vendor.contactEmail.split('@')[1];
      try {
        checkDraft(r.invoice, em, r.invoice.pay_to, {
          today: r.invoice.issued,
          category: sameDomain ? 'bank_change' : 'lookalike_vendor',
          vendorEmail: r.vendor.contactEmail,
          payeeInBody: em.body.includes(r.invoice.pay_to),
          allowSubjectDash: false,
          amount: r.invoice.total,
        });
      } catch (e) {
        failures.push(`${r.id}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('reasoning control (docs.near.ai/cloud/reasoning-models)', () => {
  const bodies = async (opts?: Parameters<typeof createGenerator>[2]) => {
    const seen: Record<string, unknown>[] = [];
    const chat = (async (body: Record<string, unknown>) => {
      seen.push(body);
      throw new Error('stub: no model');
    }) as Parameters<typeof createGenerator>[0];
    await expect(createGenerator(chat, ['m1'], opts)(input())).rejects.toThrow('all generator models failed');
    return seen;
  };

  test('default keeps the model reasoning: no chat_template_kwargs in any attempt', async () => {
    const seen = await bodies();
    expect(seen).toHaveLength(2); // structured, then plain
    for (const b of seen) expect(b).not.toHaveProperty('chat_template_kwargs');
  });

  test("thinking 'off' sends enable_thinking=false on every attempt", async () => {
    const seen = await bodies({ thinking: 'off' });
    expect(seen).toHaveLength(2);
    for (const b of seen) expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
