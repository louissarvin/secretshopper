// Accountant ledger: vault events (secret_shopper standard) folded into one row per payment, proposal, decline
// or test slot, then written as RFC 4180 CSV. Pure: the API reads events from the DB, scripts/ledger-csv.ts from chain.

export interface LedgerEvent {
  event: string;
  data: unknown;
  txHash: string;
  blockHeight: bigint | number;
  blockTime: Date;
  logIndex: number;
}

export interface LedgerOptions {
  tokenSymbol: string;
  decimals: number;
  explorerUrl: string; // https://testnet.nearblocks.io; links are <explorer>/txns/<hash>
}

export const LEDGER_COLUMNS = [
  'date_utc',
  'type',
  'status',
  'invoice_id',
  'payee',
  'amount',
  'paid_out',
  'token',
  'rail',
  'initiated_by',
  'reference',
  'note',
  'tx_link',
  'status_tx_link',
] as const;
export type LedgerRow = Record<(typeof LEDGER_COLUMNS)[number], string>;

const U128_RE = /^(0|[1-9]\d{0,38})$/;

/** Base units to a fixed decimal string: 1370000 at 6 decimals is "1.370000". Rejects anything but a u128 string. */
export const formatUnits = (units: string, decimals: number): string => {
  if (!U128_RE.test(units)) throw new Error(`not a token amount: ${units.slice(0, 40)}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error('decimals out of range');
  if (decimals === 0) return units;
  const padded = units.padStart(decimals + 1, '0');
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
};

// OWASP CSV injection: a leading = + - @ tab or CR makes spreadsheets evaluate the cell. Decline reasons come from the model.
const FORMULA_START = /^[=+\-@\t\r]/;

/** One RFC 4180 field: neutralise formulas, then quote if it holds a comma, quote, CR or LF. */
export const csvField = (value: string): string => {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CRLF line endings and a UTF-8 BOM so Excel opens non-ASCII text correctly. */
export const toCsv = (rows: LedgerRow[]): string =>
  '﻿' + [LEDGER_COLUMNS.join(','), ...rows.map((r) => LEDGER_COLUMNS.map((c) => csvField(r[c])).join(','))].join('\r\n') + '\r\n';

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const dateUtc = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 19);

type Row = LedgerRow & { _order: number };

/** Statuses: payment pending|paid|failed, proposal pending|approved|rejected, decline declined, reveal the test status. */
export const buildLedger = (events: LedgerEvent[], o: LedgerOptions): LedgerRow[] => {
  const link = (hash: string) => (hash ? `${o.explorerUrl.replace(/\/+$/, '')}/txns/${hash}` : '');
  const amount = (v: unknown) => formatUnits(str(v), o.decimals);
  const sorted = [...events].sort((a, b) => Number(BigInt(a.blockHeight) - BigInt(b.blockHeight)) || a.blockTime.getTime() - b.blockTime.getTime() || a.logIndex - b.logIndex);

  const payments = new Map<string, Row>();
  const proposals = new Map<string, Row>();
  const reveals = new Map<string, Row>(); // slot id -> its one reveal row
  const rows: Row[] = [];
  const testInvoices = new Map<string, string>(); // invoice id -> slot, from reveals
  const blank = (e: LedgerEvent, i: number): Row => ({
    _order: i,
    date_utc: dateUtc(e.blockTime),
    type: '',
    status: '',
    invoice_id: '',
    payee: '',
    amount: '',
    paid_out: '',
    token: o.tokenSymbol,
    rail: '',
    initiated_by: '',
    reference: '',
    note: '',
    tx_link: link(e.txHash),
    status_tx_link: '',
  });

  sorted.forEach((e, i) => {
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.event) {
      case 'paid': {
        const r = { ...blank(e, i), type: 'payment', status: 'pending', invoice_id: str(d.invoice_id), payee: str(d.payee), amount: amount(d.amount), rail: str(d.rail) || 'Near' };
        r.initiated_by = d.by_owner === true ? 'owner' : 'agent';
        r.reference = `payment ${str(d.payment_id)}`;
        payments.set(str(d.payment_id), r);
        rows.push(r);
        break;
      }
      case 'payment_settled': {
        const r = payments.get(str(d.payment_id));
        if (!r) break;
        r.status = d.ok === true ? 'paid' : 'failed';
        r.paid_out = d.ok === true ? r.amount : '';
        if (d.ok !== true) r.note = 'transfer failed; the funds did not leave the vault';
        r.status_tx_link = link(e.txHash);
        break;
      }
      case 'proposed': {
        const r = { ...blank(e, i), type: 'proposal', status: 'pending', invoice_id: str(d.invoice_id), payee: str(d.payee), amount: amount(d.amount), initiated_by: 'agent' };
        r.reference = `proposal ${str(d.proposal_id)}`;
        r.note = 'awaiting owner approval; no funds moved';
        proposals.set(str(d.proposal_id), r);
        rows.push(r);
        break;
      }
      case 'proposal_resolved': {
        const r = proposals.get(str(d.proposal_id));
        if (!r) break;
        r.status = d.approved === true ? 'approved' : 'rejected';
        r.note = d.approved === true ? 'approved by the owner; the payment row carries the funds' : 'rejected by the owner; no funds moved';
        r.status_tx_link = link(e.txHash);
        break;
      }
      case 'declined':
        rows.push({ ...blank(e, i), type: 'decline', status: 'declined', invoice_id: str(d.invoice_id), initiated_by: 'agent', note: str(d.reason) });
        break;
      case 'test_revealed': {
        const status = str(d.status).toLowerCase();
        // a later reveal event for a slot is a status upgrade (prove_delivery: Unanswered to Ignored), not a new row
        const prior = reveals.get(str(d.slot_id));
        if (prior) {
          prior.note = [prior.note, `status upgraded from ${prior.status} to ${status} by a delivery proof`].join('; ');
          prior.status = status;
          prior.status_tx_link = link(e.txHash);
          break;
        }
        // a void slot's invoice id is random filler, so it is left out
        const r = { ...blank(e, i), type: 'test_reveal', status, invoice_id: str(d.payee) ? str(d.invoice_id) : '', payee: str(d.payee), reference: `test slot ${str(d.slot_id)}` };
        r.note = str(d.payee) ? `internal control test${d.contained === true ? ', payment contained' : ''}` : 'empty test slot (void)';
        if (str(d.payee)) testInvoices.set(r.invoice_id, str(d.slot_id));
        reveals.set(str(d.slot_id), r);
        rows.push(r);
        break;
      }
    }
  });

  // money sent to a test payee is real on chain; flag it so it is not booked as a supplier payment
  for (const r of rows) {
    const slot = testInvoices.get(r.invoice_id);
    if (slot !== undefined && r.type !== 'test_reveal') r.note = [r.note, `internal control test (slot ${slot})`].filter(Boolean).join('; ');
  }
  return rows.sort((a, b) => a._order - b._order).map(({ _order: _o, ...r }) => r);
};

export const LEDGER_EVENTS = ['paid', 'payment_settled', 'proposed', 'proposal_resolved', 'declined', 'test_revealed'] as const;
