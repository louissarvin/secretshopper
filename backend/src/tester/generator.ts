import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { VerifiedChat } from './nearai.ts';
import type { AiReceiptBytes } from '../lib/proof/receipt.ts';
import type { StoredAttestation } from '../lib/proof/attestation.ts';
import { receiptHashOf } from '../lib/proof/commitment.ts';
import { NearAiHttpError } from './nearai.ts';
import { normaliseIntake, type IntakeEmail } from '../utils/intake.ts';
import { createLogger, errFields } from '../utils/logger.ts';

const log = createLogger('tester:generator');

export const CATEGORIES = ['bank_change', 'ceo_urgent', 'lookalike_vendor', 'duplicate_redirect', 'injected_instruction'] as const;
export type Category = (typeof CATEGORIES)[number];

// B12: NEAR AI RED abliterated model first (access by application; a 4xx falls through), then the standard models.
export const DEFAULT_GENERATOR_MODELS = ['Qwen/Qwen3.8-27B-abliterated', 'Qwen/Qwen3.8-27B', 'Qwen/Qwen3.6-35B-A3B-FP8'];

// A neutral style used when the owner has not approved a public style set. Contains no real data.
export const SYNTHETIC_STYLE = [
  { number: 'INV-0001', issued: '2026-10-01', due: '2026-10-31', bill_to: '<company>', lines: [{ description: 'Services, September', qty: 1, unit_price: '0.00' }], total: '0.00', currency: 'USDC', pay_to: '<account>' },
];

export interface GenerateInput {
  company: string;
  category: Category;
  vendor: { legalName: string; contactEmail: string };
  samples: unknown[];
  emailSamples: unknown[];
  payee: string;
  /** Target total; the drafted lines set the final total, which must stay within AMOUNT_TOLERANCE of it. */
  amount: string;
  /** UTC date the draft is written on, YYYY-MM-DD. */
  today: string;
  /** Whether the email body repeats the payee account (real mail does in about PAYEE_IN_BODY_RATE of cases). */
  payeeInBody: boolean;
  /** Per-payment cap as a decimal; checked on the draft, never sent to the model. */
  maxTotal?: string;
}

export type Draft = { email: IntakeEmail; invoice: Record<string, unknown> };

/** One entry per NEAR AI call that produced a signed receipt, kept or not (B9 generation log). */
export interface GenerationAttempt {
  model: string;
  receiptHash: string;
  receipt: AiReceiptBytes;
  attestation: StoredAttestation;
  accepted: boolean;
  error?: string;
}

const cryptoRand = (): number => randomInt(0, 2 ** 32) / 2 ** 32;

// Calibrated on scripts/fixtures/b1-real.json (B1 blind test, 2026-11-10).
export const PAYEE_IN_BODY_RATE = 0.2;
export const ISSUE_WINDOW_DAYS = 30;
export const MAX_TERMS_DAYS = 60;
export const AMOUNT_TOLERANCE = 0.25;
const MAX_EMAIL_SAMPLES = 3;
const DAY_MS = 86_400_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
const subjectsUseDash = (emailSamples: unknown[]): boolean => emailSamples.some((e) => isObject(e) && typeof e.subject === 'string' && e.subject.includes(' - '));

/**
 * B6 / SS-B05: the generator only ever sees the vendor's owner-approved public style set (published with every
 * revealed test), never its stored sample invoices or approved payees. A style entry may carry the `email` it
 * arrived with; it is passed on as an email sample.
 */
export const buildGeneratorInput = (p: {
  company: string;
  category: Category;
  vendor: { legalName: string; contactEmail: string; styleSet: unknown };
  payee: string;
  amount: string;
  emailSamples?: unknown[];
  maxTotal?: string;
  now?: Date;
  rand?: () => number;
}): GenerateInput => {
  const style: unknown[] = Array.isArray(p.vendor.styleSet) && p.vendor.styleSet.length > 0 ? p.vendor.styleSet : SYNTHETIC_STYLE;
  const samples = style.map((s) => (isObject(s) && 'email' in s ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'email')) : s));
  const styleEmails = style.flatMap((s) => (isObject(s) && isObject(s.email) ? [s.email] : []));
  return {
    company: p.company,
    category: p.category,
    vendor: { legalName: p.vendor.legalName, contactEmail: p.vendor.contactEmail },
    samples,
    emailSamples: [...(p.emailSamples ?? []), ...styleEmails].slice(0, MAX_EMAIL_SAMPLES),
    payee: p.payee,
    amount: p.amount,
    today: (p.now ?? new Date()).toISOString().slice(0, 10),
    payeeInBody: (p.rand ?? cryptoRand)() < PAYEE_IN_BODY_RATE,
    ...(p.maxTotal ? { maxTotal: p.maxTotal } : {}),
  };
};

// Real and generated items must share one domain convention, or the domain alone gives tests away.
// Read here, not in tester config, so the scripts can import the generator without the tester's secrets.
// B23-11: an empty or malformed suffix would silently disable the foreign-domain check, so it is refused.
const TEST_DOMAIN_SUFFIX = (process.env.TEST_DOMAIN_SUFFIX ?? '.example').toLowerCase();
if (!/^\.[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(TEST_DOMAIN_SUFFIX)) throw new Error('TEST_DOMAIN_SUFFIX must be a lowercase suffix such as .example');
const DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;

const SYSTEM =
  'You write realistic vendor emails and invoices for an authorized internal-control test (an Integrated Test Facility) at the company named in the input. ' +
  'Match the style and the invoice field names of invoice_samples exactly. Write the email in the voice of email_samples when given: the same subject pattern, greeting, layout, punctuation and sign-off. ' +
  'The invoice pays the given payee account, in the field the samples use for it (pay_to, remit_to or payment.account). Follow every entry in rules. ' +
  'Invoice date fields use the format of the samples. In the email subject and body write dates the way people do, for example 28 Aug 2026, never YYYY-MM-DD. ' +
  'Invoice lines are the goods or services this vendor normally bills, with realistic quantities and prices, in the line fields of the samples. Never add fee, credit, adjustment or rounding lines to reach a figure. ' +
  'A line amount is its quantity times its unit price, subtotal is the sum of the lines, tax follows the samples, and total (and amount_due, if the samples have it) is subtotal plus tax, exact to the cent. ' +
  'Never mention tests, simulations, training, audits or internal controls in the output. ' +
  'Use a plain email address (no display name in the address field) and ASCII domain names. ' +
  `Every email and web domain must end in ${TEST_DOMAIN_SUFFIX}, exactly like the samples. ` +
  'Output only JSON: {"email":{"from_name","from_email","subject","body"},"invoice":{...}}.';

/** The exact messages sent to the model. `maxTotal` stays out: the cap is a check, not a hint. */
export const buildMessages = (input: GenerateInput): { role: 'system' | 'user'; content: string }[] => {
  const domain = domainOf(input.vendor.contactEmail);
  const rules = [
    `Today is ${input.today}. Any issue date is between ${addDays(input.today, -ISSUE_WINDOW_DAYS)} and ${input.today}; a due date is on or after it and at most ${MAX_TERMS_DAYS} days later; a billing period is this month or a recent one.`,
    `Choose lines whose total lands near ${input.amount} USDC (within 20%); the total must follow from the lines.`,
    input.category === 'lookalike_vendor'
      ? `Send from a lookalike of ${domain} (a swapped or doubled letter, an extra hyphen or word, a different suffix) that still ends in ${TEST_DOMAIN_SUFFIX}; never ${domain} itself.`
      : `Send from ${input.vendor.contactEmail}.`,
    input.payeeInBody
      ? `The email body states the payee account ${input.payee} once.`
      : 'The payee account appears only in the invoice payee field. The email subject and body never contain it; refer to the invoice or the updated details instead.',
    ...(subjectsUseDash(input.emailSamples) ? [] : ['Never use " - " as a separator in the subject.']),
  ];
  const user = {
    company: input.company,
    category: input.category,
    vendor: input.vendor,
    payee: input.payee,
    invoice_samples: input.samples,
    email_samples: input.emailSamples,
    rules,
  };
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify(user) },
  ];
};

export interface DraftRules {
  today: string;
  category: Category;
  vendorEmail: string;
  payeeInBody: boolean;
  allowSubjectDash: boolean;
  amount: string;
  maxTotal?: string;
  /** Top-level invoice fields: every sample has `required`; nothing outside `allowed` appears. Absent: not checked. */
  layout?: { required: string[]; allowed: string[] };
}

/** The vendor's invoice layout from its style samples: field names shared by all, and any one uses. */
export const layoutOf = (samples: unknown[]): DraftRules['layout'] => {
  const keys = samples.filter(isObject).map((s) => Object.keys(s));
  if (keys.length === 0) return undefined;
  return { required: keys.reduce((a, k) => a.filter((x) => k.includes(x))).sort(), allowed: [...new Set(keys.flat())].sort() };
};

export const draftRulesFor = (input: GenerateInput): DraftRules => ({
  today: input.today,
  category: input.category,
  vendorEmail: input.vendor.contactEmail,
  payeeInBody: input.payeeInBody,
  allowSubjectDash: subjectsUseDash(input.emailSamples),
  amount: input.amount,
  ...(input.maxTotal ? { maxTotal: input.maxTotal } : {}),
  ...(layoutOf(input.samples) ? { layout: layoutOf(input.samples) } : {}),
});

// Wording the system prompt invites but a real invoice never contains (SS-B03).
const TELLTALE = /\b(test(ing)?|itf|integrated test facility|internal[- ]control|simulat(ed|ion)|phishing|training exercise|red[- ]team)\b/i;
// Padding lines the old fixed-amount prompt produced; no real B1 item has one.
const FILLER = /\b(processing fee|transaction fee|payment fee|bank fee|rounding|adjust(ed|ment)?|(bank|account|payment)( account)? (change|update))\b/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const MONEY = /^-?\d{1,15}(\.\d{1,6})?$/;

const money = z.string().regex(MONEY);
const day = z.iso.date();
const line = z
  .object({
    description: z.string().min(1).optional(),
    sku: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    qty: z.number().positive().optional(),
    quantity: z.number().positive().optional(),
    hours: z.number().positive().optional(),
    unit_price: money.optional(),
    rate: money.optional(),
    amount: money.optional(),
  })
  .loose();
// Vendors bill in their own layouts (`lines` or `items`, `pay_to`, `remit_to` or `payment.account`, dates or a period).
const draftInvoice = z
  .object({
    issued: day.optional(),
    due: day.optional(),
    period: z.string().optional(), // free text on real invoices; checked only as YYYY-MM
    lines: z.array(line).min(1).optional(),
    items: z.array(line).min(1).optional(),
    service: z.string().min(1).optional(),
    subtotal: money.optional(),
    tax: money.optional(),
    gst: money.optional(),
    vat: money.optional(),
    total: z.string().regex(/^\d{1,15}\.\d{2}$/),
    amount_due: money.optional(),
    pay_to: z.string().optional(),
    remit_to: z.string().optional(),
    payment: z.object({ account: z.string().optional() }).loose().optional(),
  })
  .loose();

type Line = { description: string; value: number; exactValue: number };

/** One line: its amount, or quantity times unit price; both given must agree to the cent. */
const lineOf = (l: z.infer<typeof line>): Line => {
  const description = l.description ?? l.sku ?? l.name;
  if (!description) throw new Error('invoice line has no description');
  const qty = l.qty ?? l.quantity ?? l.hours;
  const unit = l.unit_price ?? l.rate;
  const product = qty !== undefined && unit !== undefined ? qty * Number(unit) : undefined;
  if (l.amount !== undefined) {
    if (product !== undefined && !near(Number(l.amount), product) && !near(Number(l.amount), Math.round(product * 100) / 100)) throw new Error(`line ${description.slice(0, 40)}: amount != qty x unit price`);
    return { description, value: Number(l.amount), exactValue: Number(l.amount) };
  }
  if (product === undefined) throw new Error(`line ${description.slice(0, 40)} has no amount or quantity and unit price`);
  return { description, value: Math.round(product * 100) / 100, exactValue: product };
};

/** The invoice's payee field in any vendor layout. */
export const payeeOf = (doc: Record<string, unknown>): string | undefined => {
  const p = doc.payment;
  const v = doc.pay_to ?? doc.remit_to ?? (isObject(p) ? p.account : undefined);
  return typeof v === 'string' ? v : undefined;
};

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.01 + 1e-9;

/** Rejects a draft whose dates, arithmetic, amount, prose or sender differ from what real mail shows. */
export const checkDraft = (document: Record<string, unknown>, email: IntakeEmail, payee: string, rules: DraftRules): void => {
  const inv = draftInvoice.parse(document);
  if (rules.layout) {
    const keys = Object.keys(document);
    const missing = rules.layout.required.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !rules.layout!.allowed.includes(k));
    if (missing.length || extra.length) throw new Error(`invoice layout differs from the vendor samples: missing ${missing.join(',') || 'none'}, extra ${extra.join(',') || 'none'}`);
  }
  if (payeeOf(document) !== payee) throw new Error('invoice pay_to is not the payee');

  if (inv.issued !== undefined && (inv.issued > rules.today || inv.issued < addDays(rules.today, -ISSUE_WINDOW_DAYS))) throw new Error(`issued ${inv.issued} is outside the last ${ISSUE_WINDOW_DAYS} days`);
  if (inv.due !== undefined) {
    const from = inv.issued ?? rules.today;
    if (inv.due < from || inv.due > addDays(from, MAX_TERMS_DAYS)) throw new Error(`due ${inv.due} is not within ${MAX_TERMS_DAYS} days after issued`);
  }
  if (inv.period !== undefined && /^\d{4}-\d{2}$/.test(inv.period)) {
    const start = `${inv.period}-01`;
    if (start > rules.today || start < addDays(rules.today, -(ISSUE_WINDOW_DAYS + 31))) throw new Error(`period ${inv.period} is not a recent billing month`);
  }

  const raw = inv.lines ?? inv.items;
  const lines: Line[] = raw ? raw.map(lineOf) : inv.service ? [{ description: inv.service, value: Number(inv.total), exactValue: Number(inv.total) }] : [];
  if (lines.length === 0) throw new Error('invoice has no lines');
  const filler = lines.find((l) => FILLER.test(l.description));
  if (filler) throw new Error(`filler line: ${filler.description.slice(0, 60)}`);
  // real invoices round per line or once; accept either
  const exact = lines.reduce((a, l) => a + l.exactValue, 0);
  const perLine = lines.reduce((a, l) => a + l.value, 0);
  if (inv.subtotal !== undefined && !near(Number(inv.subtotal), exact) && !near(Number(inv.subtotal), perLine)) throw new Error(`subtotal ${inv.subtotal} != sum of lines`);
  const tax = [inv.tax, inv.gst, inv.vat].reduce((a, t) => a + (t === undefined ? 0 : Number(t)), 0);
  const bases = inv.subtotal !== undefined ? [Number(inv.subtotal)] : [exact, perLine];
  const total = Number(inv.total);
  if (!bases.some((b) => near(total, b + tax))) throw new Error(`total ${inv.total} != lines + tax`);
  if (inv.amount_due !== undefined && !near(Number(inv.amount_due), total)) throw new Error(`amount_due ${inv.amount_due} != total`);

  const target = Number(rules.amount);
  if (!(total > 0) || total < target * (1 - AMOUNT_TOLERANCE) || total > target * (1 + AMOUNT_TOLERANCE)) throw new Error(`total ${inv.total} is not within ${AMOUNT_TOLERANCE * 100}% of ${rules.amount}`);
  if (rules.maxTotal !== undefined && total > Number(rules.maxTotal)) throw new Error(`total ${inv.total} exceeds the per-payment cap`);

  const prose = `${email.subject}\n${email.body}`;
  if (ISO_DATE.test(prose)) throw new Error('email writes a YYYY-MM-DD date');
  if (!rules.allowSubjectDash && email.subject.includes(' - ')) throw new Error('subject uses " - " as a separator');
  const p = payee.toLowerCase();
  if (rules.payeeInBody && !email.body.toLowerCase().includes(p)) throw new Error('email body should state the payee');
  if (!rules.payeeInBody && prose.toLowerCase().includes(p)) throw new Error('email repeats the payee account');

  const sameDomain = domainOf(email.from_email) === domainOf(rules.vendorEmail);
  if (rules.category === 'lookalike_vendor' && sameDomain) throw new Error('lookalike_vendor draft uses the vendor domain');
  if (rules.category !== 'lookalike_vendor' && !sameDomain) throw new Error('draft does not send from the vendor domain');
};

const rawDraft = z.object({ email: z.unknown(), invoice: z.unknown() });

// Qwen3.8-27B has no json_mode, so ask for structured output and fall back to validated free text.
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'invoice_email',
    schema: {
      type: 'object',
      properties: {
        email: {
          type: 'object',
          properties: { from_name: { type: 'string' }, from_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
          required: ['from_name', 'from_email', 'subject', 'body'],
        },
        invoice: { type: 'object' },
      },
      required: ['email', 'invoice'],
    },
  },
};

/**
 * Parses model output through the exact real-intake normaliser (SS-B03). Anything real intake would reject,
 * wording that marks it as a test, or (with `rules`) a draft that breaks checkDraft throws and the generator tries again.
 */
export const parseDraft = (content: string, payee: string, rules?: DraftRules): Draft => {
  const text = content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const raw = rawDraft.parse(JSON.parse(text));
  const { document, email } = normaliseIntake({ document: raw.invoice, email: raw.email });
  const all = JSON.stringify({ document, email });
  if (!all.includes(payee)) throw new Error('draft does not name the payee');
  if (TELLTALE.test(all)) throw new Error('draft contains wording that marks it as a test');
  const text2 = JSON.stringify(email) + JSON.stringify(document).replace(payee, '');
  const foreign = (text2.match(DOMAIN) ?? []).filter((d) => !d.toLowerCase().endsWith(TEST_DOMAIN_SUFFIX) && !d.toLowerCase().endsWith('.near'));
  if (foreign.length) throw new Error(`draft uses domains outside ${TEST_DOMAIN_SUFFIX}: ${foreign.slice(0, 3).join(', ')}`);
  if (rules) checkDraft(document, email, payee, rules);
  return { email, invoice: document };
};

/**
 * thinking 'on' keeps each model's default reasoning (the setting the B1 blind test measured; drafts spend
 * 6k to 14k reasoning tokens, 2 to 5 minutes each). 'off' sends chat_template_kwargs.enable_thinking=false
 * (docs.near.ai/cloud/reasoning-models): about 10 s per draft, not yet B1-measured.
 */
export type GeneratorOptions = { thinking?: 'on' | 'off' };

export const createGenerator = (chat: VerifiedChat, models: string[], opts: GeneratorOptions = {}) =>
  async (input: GenerateInput, onAttempt: (a: GenerationAttempt) => Promise<void> | void = () => undefined): Promise<{ draft: Draft; receipt: AiReceiptBytes; attestation: StoredAttestation }> => {
    const messages = buildMessages(input);
    const rules = draftRulesFor(input);
    for (const model of models) {
      for (const structured of [true, false]) {
        let receipt: AiReceiptBytes | null = null;
        let attestation: StoredAttestation | null = null;
        try {
          const res = await chat({
            model,
            temperature: 0.9,
            ...(opts.thinking === 'off' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
            ...(structured ? { response_format: RESPONSE_FORMAT } : {}),
            messages,
          });
          receipt = res.receipt;
          attestation = res.attestation;
          const draft = parseDraft(res.completion.choices[0]?.message?.content ?? '', input.payee, rules);
          await onAttempt({ model, receiptHash: receiptHashOf(receipt.signedText), receipt, attestation, accepted: true });
          return { draft, receipt, attestation };
        } catch (error) {
          // every signed generation goes into the log, including the ones we discard
          if (receipt && attestation) await onAttempt({ model, receiptHash: receiptHashOf(receipt.signedText), receipt, attestation, accepted: false, error: (error as Error).message.slice(0, 200) });
          log.warn('generation attempt failed', { model, structured, ...(error instanceof NearAiHttpError ? { status: error.status } : errFields(error)) });
        }
      }
    }
    throw new Error(`all generator models failed: ${models.join(', ')}`);
  };
