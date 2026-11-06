import type { AccountFacts, Rail } from './tools.ts';

// Counterparty preflight (hackathon track 06): allow, warn or block a payment before anything is signed.
// Pure: every input is read from chain (vault views, RPC, FastNEAR) by the caller. No database, no LLM.

export type Verdict = 'allow' | 'warn' | 'block';
export type Severity = Verdict | 'info';
export interface Reason {
  code: string;
  severity: Severity;
  detail: string;
}
export interface Assessment {
  verdict: Verdict;
  reasons: Reason[];
}

export interface SpendLimits {
  max_per_payment: bigint;
  daily_cap: bigint;
  spent_24h: bigint;
}

/** Shared blocklist lookup (backend /inbox/blocklist): each entry carries an on-chain evidence tx. */
export interface BlocklistFacts {
  listed: boolean;
  count: number;
  firstEvidenceTx: string | null;
}

export const MIN_ACCOUNT_AGE_MS = 7 * 24 * 3600_000;

// Company-form words that differ between a legal name and an owner's label; not identity.
const FORM_WORDS = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'co', 'company', 'corp', 'corporation', 'pte', 'plc', 'gmbh', 'ag', 'sa', 'bv', 'pty', 'the']);
const nameKey = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FORM_WORDS.has(w))
    .join(' ');

/** AG-07: an approved payee belongs to the vendor whose name its on-chain label carries. */
export const labelMatchesVendor = (label: string, vendorName: string): boolean => {
  const a = nameKey(label);
  const b = nameKey(vendorName);
  return a.length >= 3 && b.length >= 3 && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `));
};

const rank: Record<Severity, number> = { info: 0, allow: 0, warn: 1, block: 2 };
const ageMs = (iso: string | null, nowMs: number): number | null => (iso ? nowMs - Date.parse(iso) : null);

/**
 * Approved, active, established payees inside the caps are allowed. Anything a human should see first is warn.
 * Unapproved payees that are also missing, brand new or freshly redeployed, and delisted or reserved accounts, are block.
 */
export const assessPayment = (p: {
  facts: AccountFacts;
  amount: bigint; // token base units
  rail: Rail;
  limits: SpendLimits;
  reserved: string[]; // the vault, its token and Intents contract: never payees
  nowMs: number;
  // AG-07: legal name of the vendor the invoice claims to come from; null when unknown, undefined to skip the check
  invoiceVendor?: string | null;
  // 'unavailable' when the lookup failed: a warn, never a silent allow; undefined skips the check
  blocklist?: BlocklistFacts | 'unavailable';
}): Assessment => {
  const { facts: f, limits, nowMs } = p;
  const reasons: Reason[] = [];
  const add = (severity: Severity, code: string, detail: string) => reasons.push({ code, severity, detail });
  const approved = f.approved_payee;
  const active = approved?.active === true;
  const delisted = !!approved?.removed_at && Date.parse(approved.removed_at) <= nowMs;
  // unapproved payees get the hard version of each signal
  const hard: Severity = active ? 'warn' : 'block';

  if (p.reserved.includes(f.account_id)) add('block', 'reserved_account', `${f.account_id} is the vault, its token or its Intents contract`);

  if (p.blocklist === 'unavailable') add('warn', 'blocklist_unavailable', 'the shared blocklist could not be read, so the payee was not checked against it');
  else if (p.blocklist?.listed)
    add('block', 'blocklisted', `on the shared blocklist with ${p.blocklist.count} ${p.blocklist.count === 1 ? 'entry' : 'entries'}; first evidence tx ${p.blocklist.firstEvidenceTx}`);
  else if (p.blocklist) add('info', 'not_blocklisted', 'not on the shared blocklist');

  if (delisted) add('block', 'payee_delisted', `removed from the vault's approved payees at ${approved!.removed_at}`);
  else if (!approved) add('warn', 'payee_not_approved', 'not an approved payee on the vault (get_payee_status)');
  else if (!active) add('warn', 'payee_not_yet_active', `approved, active from ${approved.active_at}`);
  else if (approved.removed_at) add('warn', 'payee_delisting_scheduled', `the owner is delisting it; inactive from ${approved.removed_at}`);
  else add('info', 'payee_approved', `approved as "${approved.label}" since ${approved.active_at}`);

  // an approved payee of another vendor is a redirect, not a payment of this invoice (AG-07)
  if (active && !delisted && p.invoiceVendor !== undefined) {
    if (p.invoiceVendor === null) add('warn', 'invoice_vendor_unknown', 'the invoice names no vendor on file, so the payee cannot be tied to it');
    else if (!labelMatchesVendor(approved!.label, p.invoiceVendor)) add('warn', 'payee_vendor_mismatch', `approved as "${approved!.label}", but the invoice is from "${p.invoiceVendor}"`);
    else add('info', 'payee_matches_vendor', `label "${approved!.label}" matches vendor "${p.invoiceVendor}"`);
  }

  // Intents credits an id inside intents.near, which need not exist as a NEAR account
  if (!f.exists) add(p.rail === 'Intents' ? 'warn' : hard, 'account_not_found', `${f.account_id} does not exist on chain`);

  const age = ageMs(f.first_tx_at, nowMs);
  const youngByHistory = f.code_history !== null && f.exists && !f.code_history.existed_at_start;
  if (age !== null && age < MIN_ACCOUNT_AGE_MS) add(hard, 'new_account', `first transaction ${f.first_tx_at}, under ${MIN_ACCOUNT_AGE_MS / 86_400_000} days ago`);
  else if (age === null && youngByHistory) add(hard, 'new_account', `did not exist ${f.code_history!.covered_hours.toFixed(1)} h ago`);
  else if (age === null && f.exists) add('info', 'account_age_unknown', 'no transaction history from the indexer');

  if (f.contract) {
    if (f.code_history?.code_changed) add(hard, 'code_changed_recently', `contract code changed in the last ${f.code_history.covered_hours.toFixed(1)} h`);
    else if (f.contract.kind === 'global_account') add('warn', 'mutable_global_code', `code follows global contract ${f.contract.id}, which its owner can replace at any time`);
    else if (!f.code_history) add('warn', 'code_history_unknown', 'receiver is a contract and its code history could not be read');
    else add('info', 'contract_code_stable', `receiver is a contract (${f.contract.kind}); code unchanged for ${f.code_history.covered_hours.toFixed(1)} h`);
  }

  if (p.amount > limits.max_per_payment) add('warn', 'over_per_payment_cap', `amount ${p.amount} exceeds max_per_payment ${limits.max_per_payment}`);
  if (limits.spent_24h + p.amount > limits.daily_cap) add('warn', 'over_daily_cap', `spent ${limits.spent_24h} + ${p.amount} exceeds daily_cap ${limits.daily_cap}`);

  add('info', f.first_seen_by_vault ? 'paid_before' : 'first_payment', f.first_seen_by_vault ? `vault first paid or proposed to it at ${f.first_seen_by_vault}` : 'this vault never paid or proposed to it');

  const worst = reasons.reduce((m, r) => Math.max(m, rank[r.severity]), 0);
  return { verdict: worst === 2 ? 'block' : worst === 1 ? 'warn' : 'allow', reasons };
};

/** Which signing call a verdict permits: pay only on allow; propose (a human approves) on allow or warn; never on block. */
export const permits = (verdict: Verdict, tool: 'pay' | 'propose'): boolean => (tool === 'pay' ? verdict === 'allow' : verdict !== 'block');
