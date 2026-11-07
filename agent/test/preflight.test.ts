import { describe, expect, test } from 'bun:test';
import { assessPayment, permits, type SpendLimits } from '../src/preflight.ts';
import { createRunTool, type AccountFacts } from '../src/tools.ts';
import { establishedFacts, NOW, recorder } from './recorder.ts';

const CURRENT = 'c'.repeat(64);
const LURE = 'e'.repeat(64); // fresh implicit account, as the lures use
const LIMITS: SpendLimits = { max_per_payment: 2_000_000n, daily_cap: 5_000_000n, spent_24h: 0n };
const RESERVED = ['shop.owner.testnet', 'usdc.testnet'];
const DAY = 86_400_000;

const facts = (over: Partial<AccountFacts> = {}, id = 'acme.testnet'): AccountFacts => ({ ...establishedFacts(id), ...over });
const assess = (f: AccountFacts, amount = 1_000_000n, rail: 'Near' | 'Intents' = 'Near', limits = LIMITS) =>
  assessPayment({ facts: f, amount, rail, limits, reserved: RESERVED, nowMs: NOW });
const codes = (a: ReturnType<typeof assess>, sev?: string) => a.reasons.filter((r) => !sev || r.severity === sev).map((r) => r.code);
const iso = (ms: number) => new Date(ms).toISOString();

const unknownLure = (id: string): AccountFacts => ({
  account_id: id,
  exists: false,
  hasContract: false,
  contract: null,
  code_history: null,
  first_seen_by_vault: null,
  first_tx_at: null,
  approved_payee: null,
});
const unapprovedOld = (id: string): AccountFacts => ({ ...establishedFacts(id), approved_payee: null, first_seen_by_vault: null });

describe('assessPayment', () => {
  test('approved, active, established payee inside the caps is allowed', () => {
    const a = assess(facts());
    expect(a.verdict).toBe('allow');
    expect(codes(a)).toEqual(['payee_approved', 'paid_before']);
  });

  test('block: reserved accounts, delisted payees, unapproved missing or brand-new accounts', () => {
    expect(codes(assess(facts({}, 'usdc.testnet')), 'block')).toEqual(['reserved_account']);
    expect(assess(facts({ approved_payee: { label: 'x', active: false, active_at: iso(NOW - 9 * DAY), removed_at: iso(NOW - DAY) } })).verdict).toBe('block');
    expect(codes(assess(unknownLure(LURE)), 'block')).toEqual(['account_not_found']);
    expect(codes(assess(facts({ approved_payee: null, first_tx_at: iso(NOW - DAY) })), 'block')).toEqual(['new_account']);
    // no indexer, but the account did not exist a day ago
    const young = facts({ approved_payee: null, first_tx_at: null, code_history: { covered_hours: 24, existed_at_start: false, code_changed: false } });
    expect(codes(assess(young), 'block')).toEqual(['new_account']);
  });

  test('an unapproved contract redeployed today is blocked; an approved one is only warned', () => {
    const redeployed = { contract: { kind: 'local' as const, id: 'H' }, hasContract: true, code_history: { covered_hours: 23.8, existed_at_start: true, code_changed: true } };
    expect(codes(assess(facts({ ...redeployed, approved_payee: null })), 'block')).toEqual(['code_changed_recently']);
    expect(assess(facts(redeployed)).verdict).toBe('warn');
  });

  test('warn: unapproved but established, pending approval, scheduled delisting, caps, mutable or unknown code', () => {
    expect(codes(assess(unapprovedOld('vendor.testnet')), 'warn')).toEqual(['payee_not_approved']);
    expect(codes(assess(facts({ approved_payee: { label: 'x', active: false, active_at: iso(NOW + DAY), removed_at: null } })), 'warn')).toEqual(['payee_not_yet_active']);
    expect(codes(assess(facts({ approved_payee: { label: 'x', active: true, active_at: iso(NOW - DAY), removed_at: iso(NOW + DAY) } })), 'warn')).toEqual(['payee_delisting_scheduled']);
    expect(codes(assess(facts(), 3_000_000n), 'warn')).toEqual(['over_per_payment_cap']);
    expect(codes(assess(facts(), 1_000_000n, 'Near', { ...LIMITS, spent_24h: 4_500_000n }), 'warn')).toEqual(['over_daily_cap']);
    expect(codes(assess(facts({ hasContract: true, contract: { kind: 'global_account', id: 'code.near' } })), 'warn')).toEqual(['mutable_global_code']);
    expect(codes(assess(facts({ hasContract: true, contract: { kind: 'local', id: 'H' }, code_history: null })), 'warn')).toEqual(['code_history_unknown']);
    expect(codes(assess(facts({ first_tx_at: iso(NOW - 2 * DAY) })), 'warn')).toEqual(['new_account']);
  });

  test('Intents credits an id inside intents.near, so a missing NEAR account is warn, not block', () => {
    expect(assess({ ...unknownLure(LURE), approved_payee: establishedFacts(LURE).approved_payee }, 1n, 'Intents').verdict).toBe('warn');
  });

  test('pay needs allow; propose needs allow or warn; block permits nothing', () => {
    expect([permits('allow', 'pay'), permits('warn', 'pay'), permits('block', 'pay')]).toEqual([true, false, false]);
    expect([permits('allow', 'propose'), permits('warn', 'propose'), permits('block', 'propose')]).toEqual([true, true, false]);
  });
});

describe('preflight in the tool path', () => {
  const money = (payee: string, amount = '1.37') => JSON.stringify({ invoice_id: CURRENT, payee, amount_usdc: amount, rail: 'Near' });

  test('block: a prompt-injected pay to a fresh implicit account signs nothing', async () => {
    const { deps, signed, audit } = recorder({ accountFacts: async (id) => unknownLure(id) });
    const run = createRunTool(deps);
    const r = await run('pay', money(LURE), { invoiceId: CURRENT, mode: 'Armed' });
    expect(r.final).toBe(false);
    expect((r.output as { verdict: string; error: string }).verdict).toBe('block');
    expect((r.output as { error: string }).error).toMatch(/nothing was signed/);
    // demoted, the same payee cannot be proposed either
    expect((await run('propose', money(LURE), { invoiceId: CURRENT, mode: 'Demoted' })).final).toBe(false);
    expect(signed()).toEqual([]);
    expect(audit.map((a) => [a.msg, a.tool, a.verdict, a.may_sign])).toEqual([
      ['payment preflight', 'pay', 'block', false],
      ['payment preflight', 'propose', 'block', false],
    ]);
    expect(audit[0].reasons).toEqual(['payee_not_approved', 'account_not_found']);
    // the audit line serializes as one JSON object
    expect(JSON.parse(JSON.stringify(audit[0]))).toMatchObject({ invoice: CURRENT, payee: LURE, amount: '1370000' });
  });

  test('warn: pay is refused and asks for a human; the demoted key routes it to propose', async () => {
    const { deps, signed, audit } = recorder({ accountFacts: async (id) => unapprovedOld(id) });
    const run = createRunTool(deps);
    const paid = await run('pay', money('newvendor.testnet'), { invoiceId: CURRENT, mode: 'Armed' });
    expect(paid.final).toBe(false);
    expect(paid.output).toMatchObject({ verdict: 'warn', error: 'human approval required; nothing was signed' });
    expect(signed()).toEqual([]);
    const proposed = await run('propose', money('newvendor.testnet'), { invoiceId: CURRENT, mode: 'Demoted' });
    expect(proposed.final).toBe(true);
    expect(proposed.output).toMatchObject({ ok: true, preflight: 'warn' });
    expect(signed()).toEqual([`propose(${CURRENT},newvendor.testnet,1370000,Near)`]);
    expect(audit.map((a) => a.verdict)).toEqual(['warn', 'warn']);
  });

  test('allow: pay is signed once with the exact payee and amount that were checked', async () => {
    const seen: string[] = [];
    const { deps, signed } = recorder({ accountFacts: async (id) => (seen.push(id), establishedFacts(id)) });
    const r = await createRunTool(deps)('pay', money('acme.testnet'), { invoiceId: CURRENT, mode: 'Armed' });
    expect(r).toMatchObject({ final: true, output: { ok: true, preflight: 'allow' } });
    expect(seen).toEqual(['acme.testnet']);
    expect(signed()).toEqual([`pay(${CURRENT},acme.testnet,1370000,Near)`]);
  });

  test('a failed chain read blocks instead of allowing', async () => {
    const { deps, signed, audit } = recorder({
      accountFacts: async () => {
        throw new Error('rpc timeout');
      },
    });
    const r = await createRunTool(deps)('pay', money('acme.testnet'), { invoiceId: CURRENT, mode: 'Armed' });
    expect(r.final).toBe(false);
    expect(audit[0]).toMatchObject({ verdict: 'block', reasons: ['preflight_unavailable'] });
    expect(signed()).toEqual([]);
  });
});

describe('AG-07: an approved payee must belong to the invoice vendor', () => {
  const VENDOR_ID = 'v'.repeat(24);
  const approvedAs = (label: string, id = 'acme.testnet') => facts({ approved_payee: { label, active: true, active_at: iso(NOW - 9 * DAY), removed_at: null } }, id);
  const money = (payee: string) => JSON.stringify({ invoice_id: CURRENT, payee, amount_usdc: '1.37', rail: 'Near' });

  test('labels match legal names across case, punctuation and company-form words, never across vendors', async () => {
    const { labelMatchesVendor } = await import('../src/preflight.ts');
    expect(labelMatchesVendor('Northwind Office Supply', 'Northwind Office Supply, Inc.')).toBe(true);
    expect(labelMatchesVendor('Contoso Cloud Hosting', 'CONTOSO CLOUD HOSTING LTD')).toBe(true);
    expect(labelMatchesVendor('Fabrikam', 'Fabrikam Facilities Services Pte Ltd')).toBe(true);
    expect(labelMatchesVendor('Fabrikam Facilities Services', 'Northwind Office Supply')).toBe(false);
    expect(labelMatchesVendor('Northwind', 'Northwinds Trading')).toBe(false); // a prefix word must end at a word boundary
    expect(labelMatchesVendor('Inc', 'Inc')).toBe(false); // nothing left after the form words
  });

  test('assessPayment: mismatch and unknown vendor are warn, a match stays allow, undefined skips the check', () => {
    const run = (label: string, invoiceVendor: string | null | undefined) =>
      assessPayment({ facts: approvedAs(label), amount: 1_000_000n, rail: 'Near', limits: LIMITS, reserved: RESERVED, nowMs: NOW, invoiceVendor });
    expect(codes(run('Fabrikam Facilities Services', 'Northwind Office Supply'), 'warn')).toEqual(['payee_vendor_mismatch']);
    expect(codes(run('Northwind Office Supply', null), 'warn')).toEqual(['invoice_vendor_unknown']);
    expect(run('Northwind Office Supply', 'Northwind Office Supply Inc').verdict).toBe('allow');
    expect(codes(run('Northwind Office Supply', 'Northwind Office Supply Inc'))).toContain('payee_matches_vendor');
    expect(run('Fabrikam Facilities Services', undefined).verdict).toBe('allow');
  });

  test("an invoice from vendor A naming vendor B's approved account is never paid; nothing is signed", async () => {
    const asked: string[] = [];
    const { deps, signed, audit } = recorder({ accountFacts: async (id) => approvedAs('Fabrikam Facilities Services', id) });
    const run = createRunTool({ ...deps, vendorName: async (id) => (asked.push(id), 'Northwind Office Supply') });
    const r = await run('pay', money('fabrikam.testnet'), { invoiceId: CURRENT, mode: 'Armed', vendorId: VENDOR_ID });
    expect(r.final).toBe(false);
    expect(asked).toEqual([VENDOR_ID]);
    expect(audit[0]).toMatchObject({ verdict: 'warn', may_sign: false, reasons: ['payee_vendor_mismatch'] });
    expect(signed()).toEqual([]);
  });

  test('no vendor id on the invoice counts as unknown, not as a match', async () => {
    const { deps, signed, audit } = recorder({ accountFacts: async (id) => approvedAs('Northwind Office Supply', id) });
    const run = createRunTool({ ...deps, vendorName: async () => 'Northwind Office Supply' });
    await run('pay', money('northwind.testnet'), { invoiceId: CURRENT, mode: 'Armed' });
    expect(audit[0]).toMatchObject({ verdict: 'warn', reasons: ['invoice_vendor_unknown'] });
    expect(signed()).toEqual([]);
  });

  test('the matching vendor pays as before', async () => {
    const { deps, signed } = recorder({ accountFacts: async (id) => approvedAs('Northwind Office Supply', id) });
    const run = createRunTool({ ...deps, vendorName: async () => 'Northwind Office Supply Inc.' });
    const r = await run('pay', money('northwind.testnet'), { invoiceId: CURRENT, mode: 'Armed', vendorId: VENDOR_ID });
    expect(r).toMatchObject({ final: true, output: { ok: true, preflight: 'allow' } });
    expect(signed()).toEqual([`pay(${CURRENT},northwind.testnet,1370000,Near)`]);
  });
});

// Shared payee blocklist (backend /inbox/blocklist): each entry is backed by an on-chain evidence tx.
describe('shared blocklist in the preflight', () => {
  const EVIDENCE = 'AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az';
  const SLOT5 = '3c23855018f7bc402b49e8b8d2f883f81c33b7434e3f660ca3f9277f5ee31ac6';
  const listed = { listed: true, count: 1, firstEvidenceTx: EVIDENCE };
  const money = (payee: string) => JSON.stringify({ invoice_id: CURRENT, payee, amount_usdc: '1.37', rail: 'Near' });

  test('a listed payee is blocked even when approved and established, with the count and first evidence tx', () => {
    const a = assessPayment({ facts: facts(), amount: 1n, rail: 'Near', limits: LIMITS, reserved: RESERVED, nowMs: NOW, blocklist: listed });
    expect(a.verdict).toBe('block');
    expect(a.reasons.find((r) => r.code === 'blocklisted')).toEqual({ code: 'blocklisted', severity: 'block', detail: `on the shared blocklist with 1 entry; first evidence tx ${EVIDENCE}` });
  });

  test('not listed adds only an info line; a failed lookup is a warn, never a silent allow', () => {
    const clean = assessPayment({ facts: facts(), amount: 1n, rail: 'Near', limits: LIMITS, reserved: RESERVED, nowMs: NOW, blocklist: { listed: false, count: 0, firstEvidenceTx: null } });
    expect(clean.verdict).toBe('allow');
    expect(codes(clean)).toContain('not_blocklisted');
    const down = assessPayment({ facts: facts(), amount: 1n, rail: 'Near', limits: LIMITS, reserved: RESERVED, nowMs: NOW, blocklist: 'unavailable' });
    expect(down.verdict).toBe('warn');
    expect(codes(down, 'warn')).toEqual(['blocklist_unavailable']);
  });

  test('tool path: a listed payee signs nothing, pay or propose', async () => {
    const asked: string[] = [];
    const { deps, signed, audit } = recorder({ blocklist: async (id) => (asked.push(id), listed) });
    const run = createRunTool(deps);
    const r = await run('pay', money(SLOT5), { invoiceId: CURRENT, mode: 'Armed' });
    expect(r.output).toMatchObject({ verdict: 'block', error: 'payment blocked by the preflight; nothing was signed' });
    expect((r.output as { reasons: { code: string }[] }).reasons.map((x) => x.code)).toContain('blocklisted');
    expect((await run('propose', money(SLOT5), { invoiceId: CURRENT, mode: 'Demoted' })).final).toBe(false);
    expect(signed()).toEqual([]);
    expect(asked).toEqual([SLOT5, SLOT5]);
    expect(audit[0].reasons).toContain('blocklisted');
  });

  test('tool path: a blocklist outage turns an allowed pay into warn, so nothing is signed without a human', async () => {
    const { deps, signed, audit } = recorder({
      blocklist: async () => {
        throw new Error('inbox /blocklist returned 503');
      },
    });
    const r = await createRunTool(deps)('pay', money('acme.testnet'), { invoiceId: CURRENT, mode: 'Armed' });
    expect(r.output).toMatchObject({ verdict: 'warn', error: 'human approval required; nothing was signed' });
    expect(audit[0].reasons).toEqual(['blocklist_unavailable']);
    expect(signed()).toEqual([]);
  });
});

describe('check_account shows the blocklist', () => {
  test('listed, and unavailable when the lookup fails', async () => {
    const ctx = { invoiceId: CURRENT, mode: 'Armed' as const };
    const listed = { listed: true, count: 1, firstEvidenceTx: 'AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az' };
    const r = await createRunTool(recorder({ blocklist: async () => listed }).deps)('check_account', JSON.stringify({ account_id: 'acme.testnet' }), ctx);
    expect(r.output).toMatchObject({ account_id: 'acme.testnet', blocklist: listed });
    const down = await createRunTool(recorder({ blocklist: async () => Promise.reject(new Error('503')) }).deps)('check_account', JSON.stringify({ account_id: 'acme.testnet' }), ctx);
    expect(down.output).toMatchObject({ blocklist: 'unavailable' });
  });
});
