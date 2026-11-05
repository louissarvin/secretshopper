import { describe, expect, test } from 'bun:test';
import { buildLedger, csvField, formatUnits, LEDGER_COLUMNS, toCsv, type LedgerEvent } from '../src/lib/ledger.ts';

const OPTS = { tokenSymbol: 'USDC', decimals: 6, explorerUrl: 'https://testnet.nearblocks.io/' };
let h = 100;
const ev = (event: string, data: Record<string, unknown>, txHash = `TX${h}`): LedgerEvent => ({
  event,
  data,
  txHash,
  blockHeight: h++,
  blockTime: new Date(Date.UTC(2026, 10, 6, 9, 0, h % 60)),
  logIndex: 0,
});

// Minimal RFC 4180 reader, used only to prove the writer round-trips.
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (f += '"'), i++;
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(f), (f = '');
    else if (c === '\r' && text[i + 1] === '\n') row.push(f), rows.push(row), (row = []), (f = ''), i++;
    else f += c;
  }
  return rows;
};

describe('CSV escaping', () => {
  test('quotes commas, quotes and line breaks; leaves plain text alone', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('')).toBe('');
  });

  test('neutralises spreadsheet formulas (OWASP CSV injection)', () => {
    expect(csvField('=HYPERLINK("http://x","pay")')).toBe(`"'=HYPERLINK(""http://x"",""pay"")"`);
    for (const lead of ['+', '-', '@', '\t', '\r']) expect(csvField(`${lead}1`).replace(/^"/, '').startsWith(`'${lead}`)).toBe(true);
  });

  test('a hostile decline reason round-trips as one cell', () => {
    const reason = 'needs human approval: "urgent",\r\n=cmd|\' /C calc\'!A0';
    const csv = toCsv(buildLedger([ev('declined', { invoice_id: 'a'.repeat(64), reason })], OPTS));
    expect(csv.startsWith('﻿date_utc,type,')).toBe(true);
    const rows = parseCsv(csv.slice(1));
    expect(rows[0]).toEqual([...LEDGER_COLUMNS]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(LEDGER_COLUMNS.length);
    expect(rows[1][LEDGER_COLUMNS.indexOf('note')]).toBe(reason);
  });
});

describe('formatUnits', () => {
  test('keeps every token decimal without floating point', () => {
    expect(formatUnits('1370000', 6)).toBe('1.370000');
    expect(formatUnits('1', 6)).toBe('0.000001');
    expect(formatUnits('0', 6)).toBe('0.000000');
    expect(formatUnits('340282366920938463463374607431768211455', 24)).toBe('340282366920938.463463374607431768211455');
    expect(formatUnits('5', 0)).toBe('5');
  });

  test('rejects anything but a u128 string', () => {
    for (const bad of ['-1', '1.5', '1e6', '', '01', 'abc']) expect(() => formatUnits(bad, 6)).toThrow();
  });
});

describe('row mapping', () => {
  const INV = (c: string) => c.repeat(64);
  const rows = buildLedger(
    [
      ev('paid', { payment_id: 0, invoice_id: INV('1'), payee: 'acme.testnet', amount: '1200000', rail: 'Near', by_owner: false }, 'PAY0'),
      ev('payment_settled', { payment_id: 0, ok: true }, 'PAY0'),
      ev('paid', { payment_id: 1, invoice_id: INV('2'), payee: 'bad.testnet', amount: '500000', rail: 'Near', by_owner: false }, 'PAY1'),
      ev('payment_settled', { payment_id: 1, ok: false }, 'PAY1'),
      ev('paid', { payment_id: 2, invoice_id: INV('3'), payee: 'slow.testnet', amount: '700000', rail: 'Intents', by_owner: false }, 'PAY2'),
      ev('proposed', { proposal_id: 0, invoice_id: INV('4'), payee: 'acme.testnet', amount: '3000000' }, 'PROP0'),
      ev('proposal_resolved', { proposal_id: 0, approved: true }, 'APPROVE0'),
      ev('paid', { payment_id: 3, invoice_id: INV('4'), payee: 'acme.testnet', amount: '3000000', rail: 'Near', by_owner: true }, 'APPROVE0'),
      ev('proposed', { proposal_id: 1, invoice_id: INV('5'), payee: 'x.testnet', amount: '100' }, 'PROP1'),
      ev('declined', { invoice_id: INV('6'), reason: 'payee change needs verification by a human' }, 'DEC'),
      ev('paid', { payment_id: 4, invoice_id: INV('7'), payee: 'f'.repeat(64), amount: '1370000', rail: 'Near', by_owner: false }, 'LURE'),
      ev('test_revealed', { slot_id: 9, status: 'Failed', contained: false, payee: 'f'.repeat(64), invoice_id: INV('7'), receipt_hash: '0'.repeat(64) }, 'REV9'),
      ev('test_revealed', { slot_id: 10, status: 'Void', contained: false, payee: '', invoice_id: INV('8'), receipt_hash: '0'.repeat(64) }, 'REV10'),
      ev('agent_armed', { public_key: 'ed25519:x', methods: 'pay,decline', ok: true }, 'ARM'),
    ],
    OPTS
  );
  const byRef = (ref: string) => rows.find((r) => r.reference === ref)!;

  test('one row per payment, proposal, decline and reveal; other events are ignored', () => {
    expect(rows.map((r) => r.type)).toEqual(['payment', 'payment', 'payment', 'proposal', 'payment', 'proposal', 'decline', 'payment', 'test_reveal', 'test_reveal']);
  });

  test('payment status follows payment_settled: paid, failed, or pending', () => {
    expect(byRef('payment 0')).toMatchObject({ status: 'paid', amount: '1.200000', paid_out: '1.200000', token: 'USDC', initiated_by: 'agent' });
    expect(byRef('payment 0').tx_link).toBe('https://testnet.nearblocks.io/txns/PAY0');
    expect(byRef('payment 0').status_tx_link).toBe('https://testnet.nearblocks.io/txns/PAY0');
    expect(byRef('payment 1')).toMatchObject({ status: 'failed', paid_out: '' });
    expect(byRef('payment 1').note).toMatch(/did not leave the vault/);
    expect(byRef('payment 2')).toMatchObject({ status: 'pending', rail: 'Intents', paid_out: '', status_tx_link: '' });
  });

  test('approved proposal links to the owner payment that carries the funds', () => {
    expect(byRef('proposal 0')).toMatchObject({ status: 'approved', paid_out: '', status_tx_link: 'https://testnet.nearblocks.io/txns/APPROVE0' });
    expect(byRef('payment 3')).toMatchObject({ status: 'pending', initiated_by: 'owner', amount: '3.000000' });
    expect(byRef('proposal 1')).toMatchObject({ status: 'pending', amount: '0.000100' });
  });

  test('decline keeps its reason; reveals carry the test status and flag the lure payment', () => {
    expect(rows.find((r) => r.type === 'decline')).toMatchObject({ status: 'declined', note: 'payee change needs verification by a human', amount: '' });
    expect(byRef('test slot 9')).toMatchObject({ status: 'failed', note: 'internal control test' });
    expect(byRef('test slot 10')).toMatchObject({ status: 'void', payee: '', invoice_id: '' });
    expect(byRef('payment 4').note).toBe('internal control test (slot 9)');
  });

  test('a delivery proof upgrades the slot row in place: one row per slot, latest status, upgrade tx linked', () => {
    const lure = { slot_id: 11, contained: false, payee: 'e'.repeat(64), invoice_id: INV('9'), receipt_hash: '0'.repeat(64) };
    const keeper = ev('test_revealed', { ...lure, status: 'Unanswered' }, 'KEEPER');
    const up = buildLedger([keeper, ev('test_revealed', { ...lure, status: 'Ignored' }, 'PROVE')], OPTS);
    expect(up).toHaveLength(1);
    expect(up[0]).toMatchObject({
      type: 'test_reveal',
      status: 'ignored',
      reference: 'test slot 11',
      tx_link: 'https://testnet.nearblocks.io/txns/KEEPER',
      status_tx_link: 'https://testnet.nearblocks.io/txns/PROVE',
    });
    expect(up[0].note).toBe('internal control test; status upgraded from unanswered to ignored by a delivery proof');
    expect(up[0].date_utc).toBe(keeper.blockTime.toISOString().replace('T', ' ').slice(0, 19)); // the reveal date stays
  });

  test('summing paid_out gives cash out, with no double count from proposals', () => {
    const total = rows.reduce((s, r) => s + (r.paid_out ? BigInt(r.paid_out.replace('.', '')) : 0n), 0n);
    expect(total).toBe(1_200_000n);
  });
});
