import { describe, expect, test } from 'bun:test';
import { createRunTool, MAX_SIGNS_PER_INVOICE, toBaseUnits, toolsFor, truncateUtf8 } from '../src/tools.ts';
import { recorder } from './recorder.ts';

const CURRENT = 'a'.repeat(64);
const FOREIGN = 'b'.repeat(64);
describe('toBaseUnits', () => {
  test('converts decimal strings', () => {
    expect(toBaseUnits('1.5')).toBe('1500000');
    expect(toBaseUnits('0.000001')).toBe('1');
    expect(toBaseUnits('12')).toBe('12000000');
    expect(toBaseUnits('2.5', 18)).toBe('2500000000000000000');
  });

  test('rejects bad input', () => {
    for (const bad of ['1.1234567', '-1', '1e3', '', ' 1', '1.', '.5', '0', '0.000000', 'NaN', '1,5']) {
      expect(() => toBaseUnits(bad)).toThrow();
    }
  });
});

describe('runTool', () => {
  test('refuses a foreign invoice_id before any chain call', async () => {
    const { deps, calls } = recorder();
    const run = createRunTool(deps);
    for (const [name, args] of [
      ['pay', { invoice_id: FOREIGN, payee: 'attacker.testnet', amount_usdc: '1', rail: 'Near' }],
      ['decline', { invoice_id: FOREIGN, reason: 'x' }],
      ['propose', { invoice_id: FOREIGN, payee: 'attacker.testnet', amount_usdc: '1', rail: 'Near' }],
    ] as const) {
      const r = await run(name, JSON.stringify(args), { invoiceId: CURRENT, mode: name === 'propose' ? 'Demoted' : 'Armed' });
      expect(r.final).toBe(false);
      expect(r.output).toEqual({ error: 'invoice_id must be the current invoice' });
    }
    expect(calls).toEqual([]);
  });

  test('pays the current invoice in base units', async () => {
    const { deps, signed } = recorder();
    const r = await createRunTool(deps)('pay', JSON.stringify({ invoice_id: CURRENT, payee: 'acme.testnet', amount_usdc: '1.25', rail: 'Near' }), { invoiceId: CURRENT, mode: 'Armed' });
    expect(r.final).toBe(true);
    expect(signed()).toEqual([`pay(${CURRENT},acme.testnet,1250000,Near)`]);
  });

  test('mode gates pay and propose without touching the chain', async () => {
    const { deps, calls } = recorder();
    const run = createRunTool(deps);
    const args = JSON.stringify({ invoice_id: CURRENT, payee: 'acme.testnet', amount_usdc: '1', rail: 'Near' });
    expect((await run('pay', args, { invoiceId: CURRENT, mode: 'Demoted' })).final).toBe(false);
    expect((await run('propose', args, { invoiceId: CURRENT, mode: 'Armed' })).final).toBe(false);
    expect(calls).toEqual([]);
  });

  test('Intents rail is refused when disabled, allowed when enabled', async () => {
    const args = JSON.stringify({ invoice_id: CURRENT, payee: 'acme.testnet', amount_usdc: '1', rail: 'Intents' });
    const off = recorder();
    expect((await createRunTool(off.deps)('pay', args, { invoiceId: CURRENT, mode: 'Armed' })).output).toEqual({ error: 'rail must be Near on this vault' });
    expect(off.calls).toEqual([]);
    const on = recorder({ intentsEnabled: true });
    expect((await createRunTool(on.deps)('pay', args, { invoiceId: CURRENT, mode: 'Armed' })).final).toBe(true);
    expect(toolsFor('Armed', false).some((t) => JSON.stringify(t).includes('Intents'))).toBe(false);
  });

  test('rejects invalid payee, amount and JSON before any chain call', async () => {
    const { deps, calls } = recorder();
    const run = createRunTool(deps);
    const ctx = { invoiceId: CURRENT, mode: 'Armed' as const };
    expect((await run('pay', JSON.stringify({ invoice_id: CURRENT, payee: 'Not An Account', amount_usdc: '1' }), ctx)).final).toBe(false);
    expect((await run('pay', JSON.stringify({ invoice_id: CURRENT, payee: 'acme.testnet', amount_usdc: '1e9' }), ctx)).final).toBe(false);
    expect((await run('pay', '{not json', ctx)).final).toBe(false);
    expect((await run('check_account', JSON.stringify({ account_id: '../etc' }), ctx)).final).toBe(false);
    expect(calls).toEqual([]);
  });

  test('chain errors come back as non-final tool output', async () => {
    const { deps } = recorder({ pay: async () => { throw new Error('Smart contract panicked: amount out of bounds'); } });
    const r = await createRunTool(deps)('pay', JSON.stringify({ invoice_id: CURRENT, payee: 'acme.testnet', amount_usdc: '1' }), { invoiceId: CURRENT, mode: 'Armed' });
    expect(r).toEqual({ final: false, output: { error: 'Smart contract panicked: amount out of bounds' } });
  });

  test('decline reason is capped at 140 bytes (v2 contract)', async () => {
    let sent = '';
    const { deps } = recorder({ decline: async (_id, reason) => { sent = reason; return { ok: true }; } });
    await createRunTool(deps)('decline', JSON.stringify({ invoice_id: CURRENT, reason: 'é'.repeat(300) }), { invoiceId: CURRENT, mode: 'Armed' });
    expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(140);
    expect(truncateUtf8('abc', 2)).toBe('ab');
  });

  test('AG-02: at most three signed calls per invoice, however many the model asks for', async () => {
    let sent = 0;
    const { deps } = recorder({
      pay: async () => {
        sent++;
        throw new Error('Smart contract panicked: payment count limit reached');
      },
      decline: async () => (sent++, { ok: true }),
    });
    const run = createRunTool(deps);
    const ctx = { invoiceId: CURRENT, mode: 'Armed' as const };
    const pay = JSON.stringify({ invoice_id: CURRENT, payee: 'acme.testnet', amount_usdc: '1', rail: 'Near' });
    for (let i = 0; i < 50; i++) await run('pay', pay, ctx);
    expect(sent).toBe(MAX_SIGNS_PER_INVOICE);
    expect((await run('decline', JSON.stringify({ invoice_id: CURRENT, reason: 'x' }), ctx)).output).toEqual({ error: 'no more transactions are signed for this invoice; stop' });
    expect(sent).toBe(MAX_SIGNS_PER_INVOICE);
    // a refusal before signing spends nothing, and the next invoice starts fresh
    expect((await run('pay', JSON.stringify({ invoice_id: CURRENT, payee: 'Bad Id', amount_usdc: '1' }), ctx)).output).toEqual({ error: 'payee is not a valid NEAR account id' });
    expect((await run('decline', JSON.stringify({ invoice_id: FOREIGN, reason: 'x' }), { invoiceId: FOREIGN, mode: 'Armed' })).final).toBe(true);
    expect(sent).toBe(MAX_SIGNS_PER_INVOICE + 1);
  });

  test('AG-02: a preflight refusal leaves the budget for the decline', async () => {
    const { deps, signed } = recorder({ accountFacts: async (a) => ({ ...(await import('./recorder.ts')).establishedFacts(a), approved_payee: null }) });
    const run = createRunTool(deps);
    const ctx = { invoiceId: CURRENT, mode: 'Armed' as const };
    for (let i = 0; i < 10; i++) expect((await run('pay', JSON.stringify({ invoice_id: CURRENT, payee: 'attacker.testnet', amount_usdc: '1' }), ctx)).final).toBe(false);
    expect((await run('decline', JSON.stringify({ invoice_id: CURRENT, reason: 'payee not approved' }), ctx)).final).toBe(true);
    expect(signed()).toEqual([`decline(${CURRENT},payee not approved)`]);
  });
});
