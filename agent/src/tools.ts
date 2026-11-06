import type OpenAI from 'openai';
import { log } from './log.ts';
import { assessPayment, permits, type Assessment, type BlocklistFacts, type SpendLimits } from './preflight.ts';

// No config or chain imports here: everything with side effects comes in through ToolDeps.

export type Mode = 'Unarmed' | 'Armed' | 'Demoted' | 'Frozen';
export type Rail = 'Near' | 'Intents';

export interface AccountFacts {
  account_id: string;
  exists: boolean;
  hasContract: boolean;
  contract: { kind: 'local' | 'global_hash' | 'global_account'; id: string } | null;
  // view_account at a block about a day back; null when that block is not readable (non-archival RPC, outage)
  code_history: { covered_hours: number; existed_at_start: boolean; code_changed: boolean } | null;
  first_seen_by_vault: string | null; // ISO time the vault first paid or proposed to this account
  first_tx_at: string | null; // oldest transaction of the account, if the indexer knows it
  approved_payee: { label: string; active: boolean; active_at: string; removed_at: string | null } | null; // on-chain approval, get_payee_status
}

export interface ToolDeps {
  getVendor: (vendorId: string) => Promise<unknown>;
  accountFacts: (accountId: string) => Promise<AccountFacts>;
  spendLimits: () => Promise<SpendLimits>;
  reservedAccounts: string[];
  decline: (invoiceId: string, reason: string) => Promise<unknown>;
  pay: (invoiceId: string, payee: string, amount: string, rail: Rail) => Promise<unknown>;
  propose: (invoiceId: string, payee: string, amount: string, rail: Rail) => Promise<unknown>;
  intentsEnabled: boolean;
  tokenDecimals: number;
  audit?: (msg: string, fields: Record<string, unknown>) => void; // defaults to the JSON log
  nowMs?: () => number;
  maxSignsPerInvoice?: number; // defaults to MAX_SIGNS_PER_INVOICE
  vendorName?: (vendorId: string) => Promise<string | null>; // AG-07: legal name on file; omitted skips the label check
  blocklist?: (accountId: string) => Promise<BlocklistFacts>; // shared blocklist; a failed lookup is a warn, omitted skips it
  // advisory: sign despite warn or block (except HARD_BLOCKS) to benchmark a bare model over MCP; index.ts never sets it
  preflightMode?: PreflightMode;
}

export type PreflightMode = 'enforce' | 'advisory';
// no model judgment involved: the vault's own accounts, or no facts at all; refused in both modes
export const HARD_BLOCKS = new Set(['reserved_account', 'preflight_unavailable']);

export type ToolResult = { final: boolean; output: unknown };

const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccountId = (s: unknown): s is string => typeof s === 'string' && s.length >= 2 && s.length <= 64 && ACCOUNT_ID_RE.test(s);
const VENDOR_ID_RE = /^[a-z0-9]{20,32}$/;
const MAX_REASON_BYTES = 140; // v2 contract limit, in bytes
// Each signed call burns key gas even when the contract refuses it; enough for a refused pay, a retry and a decline (AG-02).
export const MAX_SIGNS_PER_INVOICE = 3;
export const OUT_OF_SIGNS = 'no more transactions are signed for this invoice; stop';

/** "1.5" -> "1500000" at 6 decimals. Rejects signs, exponents, too many decimals and zero. */
export const toBaseUnits = (amount: string, decimals = 6): string => {
  if (typeof amount !== 'string' || !new RegExp(`^\\d{1,15}(\\.\\d{1,${decimals}})?$`).test(amount)) {
    throw new Error(`amount must be a decimal string with at most ${decimals} decimals`);
  }
  const [whole, frac = ''] = amount.split('.');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (units === 0n) throw new Error('amount must be positive');
  return units.toString();
};

export const truncateUtf8 = (s: string, maxBytes: number): string => {
  let out = s;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
};

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): OpenAI.Chat.ChatCompletionFunctionTool => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const toolsFor = (mode: Mode, intentsEnabled: boolean): OpenAI.Chat.ChatCompletionTool[] => {
  const money = {
    invoice_id: { type: 'string', description: 'The id of the invoice you are processing.' },
    payee: { type: 'string', description: 'NEAR account id to pay.' },
    amount_usdc: { type: 'string', description: 'Decimal string, for example "12.50".' },
    rail: { type: 'string', enum: intentsEnabled ? ['Near', 'Intents'] : ['Near'] },
  };
  return [
    fn('get_vendor', 'Vendor master record: legal name and contact on file, plus the payees approved on the vault itself.', { vendor_id: { type: 'string' } }, ['vendor_id']),
    fn('check_account', 'On-chain facts about a NEAR account id: exists, has a contract, whether the vault approved it, when this vault first paid it, account age, and whether it is on the shared blocklist.', { account_id: { type: 'string' } }, ['account_id']),
    fn('decline', 'Refuse to pay this invoice. Final.', { invoice_id: { type: 'string' }, reason: { type: 'string' } }, ['invoice_id', 'reason']),
    mode === 'Armed'
      ? fn('pay', 'Pay this invoice from the vault. Final.', money, ['invoice_id', 'payee', 'amount_usdc', 'rail'])
      : fn('propose', 'Ask a human to approve this payment. Final.', money, ['invoice_id', 'payee', 'amount_usdc', 'rail']),
  ];
};

const err = (error: string): ToolResult => ({ final: false, output: { error } });

const auditLog = (msg: string, f: Record<string, unknown>) => (f.verdict === 'allow' ? log.info : log.warn)(msg, f);

const refusal = (a: Assessment, tool: 'pay' | 'propose') => {
  const reasons = a.reasons.filter((r) => r.severity === 'block' || r.severity === 'warn');
  if (a.verdict === 'block') return { error: 'payment blocked by the preflight; nothing was signed', verdict: a.verdict, reasons };
  // warn on pay: only a human may approve; an Armed key holds pay,decline only, so it cannot propose
  return {
    error: 'human approval required; nothing was signed',
    verdict: a.verdict,
    reasons,
    next: tool === 'pay' ? 'This key cannot propose while Armed. Decline with a reason starting "needs human approval:" and the main reason.' : undefined,
  };
};

/** Validates every argument before anything touches the chain; chain errors come back to the model as tool output. */
export const createRunTool = (deps: ToolDeps) => {
  // invoices run one at a time, so one counter covers the current invoice and its retries
  let budget = { invoice: '', used: 0 };
  const overBudget = (invoiceId: string): ToolResult | null => {
    if (budget.invoice !== invoiceId) budget = { invoice: invoiceId, used: 0 };
    if (budget.used >= (deps.maxSignsPerInvoice ?? MAX_SIGNS_PER_INVOICE)) return err(OUT_OF_SIGNS);
    budget.used++;
    return null;
  };

  // a read failure must never read as "allow": no facts, no signature
  const preflight = async (payee: string, amount: bigint, rail: Rail, vendorId?: string): Promise<Assessment> => {
    try {
      const vendor = !deps.vendorName ? undefined : vendorId && VENDOR_ID_RE.test(vendorId) ? deps.vendorName(vendorId) : Promise.resolve(null);
      const listed = deps.blocklist?.(payee).catch((e: unknown) => {
        log.warn('blocklist lookup failed', { payee, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
        return 'unavailable' as const;
      });
      const [facts, limits, invoiceVendor, blocklist] = await Promise.all([deps.accountFacts(payee), deps.spendLimits(), vendor, listed]);
      return assessPayment({ facts, amount, rail, limits, reserved: deps.reservedAccounts, nowMs: (deps.nowMs ?? Date.now)(), invoiceVendor, blocklist });
    } catch (e) {
      return { verdict: 'block', reasons: [{ code: 'preflight_unavailable', severity: 'block', detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) }] };
    }
  };

  return async (name: string, rawArgs: string, ctx: { invoiceId: string; mode: Mode; vendorId?: string }): Promise<ToolResult> => {
    let a: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawArgs || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return err('arguments must be a JSON object');
      a = parsed as Record<string, unknown>;
    } catch {
      return err('arguments must be valid JSON');
    }
    // the model may only act on the invoice it is looking at; checked before any chain call
    if ('invoice_id' in a && String(a.invoice_id).toLowerCase() !== ctx.invoiceId) return err('invoice_id must be the current invoice');

    const rail = (): Rail | null => {
      const r = a.rail ?? 'Near';
      if (r === 'Near') return 'Near';
      if (r === 'Intents' && deps.intentsEnabled) return 'Intents';
      return null;
    };

    try {
      switch (name) {
        case 'get_vendor':
          if (typeof a.vendor_id !== 'string' || !VENDOR_ID_RE.test(a.vendor_id)) return err('unknown vendor_id format');
          return { final: false, output: (await deps.getVendor(a.vendor_id)) ?? { error: 'vendor not found' } };
        case 'check_account':
          if (!isAccountId(a.account_id)) return err('not a valid NEAR account id');
          if (!deps.blocklist) return { final: false, output: await deps.accountFacts(a.account_id) };
          {
            const [facts, blocklist] = await Promise.all([deps.accountFacts(a.account_id), deps.blocklist(a.account_id).catch(() => 'unavailable' as const)]);
            return { final: false, output: { ...facts, blocklist } };
          }
        case 'decline': {
          if (!('invoice_id' in a)) return err('invoice_id is required');
          const reason = truncateUtf8(String(a.reason ?? '').trim(), MAX_REASON_BYTES);
          if (!reason) return err('reason is required');
          const spent = overBudget(ctx.invoiceId);
          if (spent) return spent;
          return { final: true, output: await deps.decline(ctx.invoiceId, reason) };
        }
        case 'pay':
        case 'propose': {
          const allowed = name === 'pay' ? ctx.mode === 'Armed' : ctx.mode === 'Demoted';
          if (!allowed) return err(`${name} is not available in mode ${ctx.mode}`);
          if (!('invoice_id' in a)) return err('invoice_id is required');
          if (!isAccountId(a.payee)) return err('payee is not a valid NEAR account id');
          const r = rail();
          if (!r) return err('rail must be Near on this vault');
          const amount = toBaseUnits(String(a.amount_usdc ?? ''), deps.tokenDecimals);
          // the preflight sits between the model and the signer, on the exact payee and amount about to be signed
          const check = await preflight(a.payee, BigInt(amount), r, ctx.vendorId);
          const passed = permits(check.verdict, name);
          const override = !passed && deps.preflightMode === 'advisory' && !check.reasons.some((x) => HARD_BLOCKS.has(x.code));
          const flagged = check.reasons.filter((x) => x.severity !== 'info');
          (deps.audit ?? auditLog)('payment preflight', {
            invoice: ctx.invoiceId,
            tool: name,
            mode: ctx.mode,
            payee: a.payee,
            amount,
            rail: r,
            verdict: check.verdict,
            may_sign: passed || override,
            reasons: flagged.map((x) => x.code),
            ...(deps.preflightMode === 'advisory' ? { preflight_mode: 'advisory' } : {}),
          });
          if (!passed && !override) return { final: false, output: refusal(check, name) };
          const spent = overBudget(ctx.invoiceId);
          if (spent) return spent;
          if (override) {
            (deps.audit ?? log.warn)(`advisory preflight: signing despite ${check.verdict}`, { invoice: ctx.invoiceId, tool: name, payee: a.payee, amount, verdict: check.verdict, reasons: flagged.map((x) => x.code) });
          }
          const out = await deps[name](ctx.invoiceId, a.payee, amount, r);
          const advice = deps.preflightMode === 'advisory' ? { preflight_mode: 'advisory', preflight_reasons: flagged, overridden: override } : {};
          return { final: true, output: { ...(out as object), preflight: check.verdict, ...advice } };
        }
        default:
          return err(`unknown tool ${name}`);
      }
    } catch (e) {
      // contract panics (cap, new payee limit, mode) are useful to the model; it can still decline
      return err((e instanceof Error ? e.message : String(e)).slice(0, 300));
    }
  };
};
