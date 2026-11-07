import { closeTicks, syncAcks, type AckDeps } from '../acks.ts';
import type { Inbox, InboxItem } from '../inboxClient.ts';
import { POLICY } from '../policy.ts';
import { OUT_OF_SIGNS, type Mode, type PreflightMode, type ToolResult } from '../tools.ts';
import type { PolicyView, Release, Status } from '../vault.ts';

// One external agent per process. This holds what index.ts holds for the native loop: the inbox cursor, the invoice
// being decided, the per-invoice sign budget (inside runTool) and the ack walk. Nothing here talks MCP.

export type RunTool = (name: string, rawArgs: string, ctx: { invoiceId: string; mode: Mode; vendorId?: string }) => Promise<ToolResult>;

export interface SessionDeps {
  vault: {
    getStatus: () => Promise<Status>;
    getPolicy: () => Promise<PolicyView>;
    getDecision: (invoiceId: string) => Promise<unknown>;
    getRelease: (releaseAtNs: string) => Promise<Release | null>;
    ack: (releaseAtNs: string, root: string) => Promise<{ txHash: string }>;
    publicKey: () => string;
  };
  inbox: Pick<Inbox, 'nextInvoice' | 'loadState' | 'saveState' | 'advance'>;
  runTool: RunTool; // createRunTool: validation, mode gating, preflight and the sign cap, as in the native agent
  vaultId: string;
  company: string;
  intentsEnabled: boolean;
  tokenDecimals: number;
  listedOnly: boolean;
  preflightMode: PreflightMode; // must match the runTool's; reported by get_status
  // the MCP stand-ins for MAX_STEPS: past either, the invoice ends undecided
  decisionTimeoutMs: number;
  maxToolCallsPerInvoice: number;
  maxResultBytes: number; // next_invoice results above this are never shown to the client (NF-01)
  nowMs: () => number;
  log: AckDeps['log'];
}

/** The AP policy of src/policy.ts, with the final tool named for both modes since the mode can change mid-session. */
export const mcpPolicy = (company: string): string =>
  POLICY.replace('{COMPANY}', company).replace('{FINAL_TOOL}', 'pay (propose while get_status reports mode Demoted)');

const METHODS: Record<Mode, string[]> = { Armed: ['pay', 'decline', 'ack'], Demoted: ['propose', 'decline', 'ack'], Unarmed: [], Frozen: [] };
const MAX_SKIPPED = 50; // already-decided items passed over in one next_invoice

export const fromBaseUnits = (v: string, decimals: number): string => {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
};

const vendorIdOf = (item: InboxItem): string | undefined => {
  const v = (item.document as { vendor_id?: unknown } | null)?.vendor_id;
  return typeof v === 'string' ? v : undefined;
};

// worked: the model called a tool that acts on the invoice after it was served, evidence it read it (NF-01)
type Current = { item: InboxItem; servedAt: number; calls: number; worked: boolean };
type ToolName = 'get_status' | 'next_invoice' | 'get_vendor' | 'check_account' | 'pay' | 'propose' | 'decline';
const WORK_TOOLS = new Set<ToolName>(['get_vendor', 'check_account', 'pay', 'propose', 'decline']);
export const TOO_LARGE = 'too large for the client';

export const createSession = async (d: SessionDeps) => {
  const state = await d.inbox.loadState();
  const myKey = d.vault.publicKey();
  const policy = mcpPolicy(d.company);
  let current: Current | null = null;
  let skipped: { invoice_id: string; reason: string; acked: boolean } | null = null; // reported once by the next next_invoice

  // MCP clients may call tools in parallel; one queue keeps the cursor, the sign budget and the key's nonces in order
  let queue: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const save = () => d.inbox.saveState(state);
  const canSign = (s: Status) => (s.mode === 'Armed' || s.mode === 'Demoted') && s.agent_key === myKey;
  const finalTool = (m: Mode) => (m === 'Armed' ? 'pay' : m === 'Demoted' ? 'propose' : null);
  const ackDeps: AckDeps = {
    getRelease: d.vault.getRelease,
    ack: d.vault.ack,
    canSign: async () => canSign(await d.vault.getStatus()),
    save,
    nowMs: d.nowMs,
    log: d.log,
  };

  const budgetOf = (c: Current) => ({
    decide_by: new Date(c.servedAt + d.decisionTimeoutMs).toISOString(),
    tool_calls_left: Math.max(0, d.maxToolCallsPerInvoice - c.calls),
  });

  const present = (c: Current, mode: Mode) => ({
    invoice_id: c.item.id,
    received_at: c.item.receivedAt,
    email: c.item.email,
    invoice: c.item.document,
    mode,
    final_tool: finalTool(mode),
    ...budgetOf(c),
    policy,
  });

  const done = async (item: InboxItem): Promise<void> => {
    await d.inbox.advance(state, item);
    current = null;
  };

  // Like MAX_STEPS in index.ts, an invoice the model worked on and left undecided is acked. One it never acted on is
  // left out, like MAX_ATTEMPTS (AG-03): the server cannot tell a model that ignored it from a client that never read it (NF-01).
  const giveUp = async (item: InboxItem, reason: string, ack: boolean, f: Record<string, unknown> = {}): Promise<void> => {
    await d.inbox.advance(state, item, { ack });
    if (current?.item.id === item.id) current = null;
    skipped = { invoice_id: item.id, reason, acked: ack };
    d.log.warn('invoice left undecided over mcp', { invoice: item.id, reason, acked: ack, ...f });
  };
  const expire = (c: Current, reason: string) => giveUp(c.item, reason, c.worked, { toolCalls: c.calls, heldMs: d.nowMs() - c.servedAt });

  /** Runs under the lock before every tool call and every background step (tool null: counts nothing). */
  const enforce = async (tool: ToolName | null): Promise<void> => {
    const c = current;
    if (!c) return;
    if (d.nowMs() - c.servedAt >= d.decisionTimeoutMs) return expire(c, `no decision within ${d.decisionTimeoutMs / 1000} s`);
    if (!tool) return;
    if (c.calls >= d.maxToolCallsPerInvoice) return expire(c, `no decision within ${d.maxToolCallsPerInvoice} tool calls`);
    c.calls++;
    if (WORK_TOOLS.has(tool)) c.worked = true;
  };
  const counted = (tool: ToolName) => locked(() => enforce(tool));

  const status = async () => {
    await counted('get_status');
    const [s, p] = await Promise.all([d.vault.getStatus(), d.vault.getPolicy()]);
    const amount = (v: string) => ({ base_units: v, usdc: fromBaseUnits(v, d.tokenDecimals) });
    const lanes = p.key_nonces ?? 0;
    const c = current;
    return {
      vault: d.vaultId,
      contract_version: s.version ?? null,
      mode: s.mode,
      final_tool: canSign(s) ? finalTool(s.mode) : null,
      agent_key: {
        public_key: myKey,
        armed_on_vault: s.agent_key === myKey,
        pending_on_vault: s.pending_key === myKey,
        kind: lanes > 0 ? 'gas_key' : 'classic',
        lanes,
        methods: canSign(s) ? METHODS[s.mode] : [],
      },
      limits: {
        token_id: s.token_id,
        token_decimals: d.tokenDecimals,
        max_per_payment: amount(p.max_per_payment),
        daily_cap: amount(p.daily_cap),
        spent_24h: amount(s.spent_24h),
        max_payments_per_day: p.max_payments_per_day,
        max_new_payees_per_day: p.max_new_payees_per_day,
        max_decisions_per_day: p.max_decisions_per_day,
      },
      rails: d.intentsEnabled ? ['Near', 'Intents'] : ['Near'],
      listed_only: d.listedOnly,
      preflight_mode: d.preflightMode,
      current_invoice: c ? { invoice_id: c.item.id, ...budgetOf(c) } : null,
    };
  };

  /** The invoice to decide now; the same one until it is decided or given up. Same cursor rules as index.ts. */
  const nextInvoice = () =>
    locked(async () => {
      await enforce('next_invoice');
      const r = await serve();
      const note = skipped;
      skipped = null;
      return note ? { ...r, skipped_previous: note } : r;
    });

  const serve = async (): Promise<Record<string, unknown>> => {
    const s = await d.vault.getStatus();
    if (!canSign(s)) {
      // index.ts holds the cursor the same way until the owner and vendor arm this key
      return { invoice: null, waiting: true, mode: s.mode, key_armed: s.agent_key === myKey, detail: 'No invoice is served until this key is armed on the vault. Call get_status later.' };
    }
    if (current) {
      if (!(await d.vault.getDecision(current.item.id))) return present(current, s.mode);
      d.log.info('already decided on chain', { invoice: current.item.id });
      await done(current.item);
    }
    for (let i = 0; i < MAX_SKIPPED; i++) {
      const item = await d.inbox.nextInvoice(state.cursor);
      if (closeTicks(state.acks, item?.receivedAt ?? null, d.nowMs())) await save();
      if (!item) return { invoice: null, detail: 'No undecided invoice in the inbox. Call next_invoice again later.' };
      if (await d.vault.getDecision(item.id)) {
        d.log.info('already decided on chain', { invoice: item.id });
        await done(item);
        continue;
      }
      // the call that served it is the first of its budget
      const c: Current = { item, servedAt: d.nowMs(), calls: 1, worked: false };
      const shown = present(c, s.mode);
      // a client that cannot show the whole item to its model must not let it be proven delivered (NF-01)
      const bytes = Buffer.byteLength(JSON.stringify(shown));
      if (bytes > d.maxResultBytes) {
        await giveUp(item, TOO_LARGE, false, { bytes, limit: d.maxResultBytes });
        continue;
      }
      current = c;
      return shown;
    }
    return { invoice: null, detail: 'Skipped invoices already decided on chain. Call next_invoice again.' };
  };

  /** pay, propose or decline on the current invoice through runTool. A final call or a spent budget moves the cursor. */
  const decide = (name: 'pay' | 'propose' | 'decline', args: Record<string, unknown>) =>
    locked(async (): Promise<Record<string, unknown>> => {
      await enforce(name);
      const c = current;
      if (!c) return { error: 'no current invoice; call next_invoice first' };
      const s = await d.vault.getStatus();
      if (!canSign(s)) return { error: 'this key is not armed on the vault; nothing was signed', mode: s.mode };
      const r = await d.runTool(name, JSON.stringify(args), { invoiceId: c.item.id, mode: s.mode, vendorId: vendorIdOf(c.item) });
      const out: Record<string, unknown> = { ...(r.output as Record<string, unknown>), invoice_id: c.item.id, mode: s.mode };
      if (r.final) {
        await done(c.item);
        d.log.info('invoice decided over mcp', { invoice: c.item.id, tool: name, mode: s.mode });
        return { ...out, decided: true, next: 'Call next_invoice for the next invoice.' };
      }
      if (out.error === OUT_OF_SIGNS) {
        // as index.ts does when the model ends an invoice undecided: past it, and in the ack
        await done(c.item);
        d.log.warn('invoice left undecided after the sign budget', { invoice: c.item.id });
        return { ...out, decided: false, next: 'This invoice is closed without a decision. Call next_invoice.' };
      }
      const wrong = (name === 'pay' && s.mode === 'Demoted') || (name === 'propose' && s.mode === 'Armed');
      return wrong ? { ...out, hint: `Use ${finalTool(s.mode)} or decline in mode ${s.mode}.` } : out;
    });

  /** get_vendor and check_account: same validation as the native tools; only the budget step takes the lock. */
  const read = async (name: 'get_vendor' | 'check_account', args: Record<string, unknown>) => {
    await counted(name);
    return (await d.runTool(name, JSON.stringify(args), { invoiceId: current?.item.id ?? '', mode: 'Unarmed' })).output;
  };

  /** One step of the background walk: enforce the deadline, ack closed ticks, close the open tick on what comes next. */
  const tick = () =>
    locked(async () => {
      await enforce(null);
      await syncAcks(state.acks, ackDeps);
      const next = current?.item ?? (await d.inbox.nextInvoice(state.cursor));
      if (closeTicks(state.acks, next?.receivedAt ?? null, d.nowMs())) await save();
    });

  const startAckLoop = (everyMs: number): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      try {
        await tick();
      } catch (error) {
        d.log.error('ack walk failed', { error: error instanceof Error ? error.message : String(error) });
      }
      if (!stopped) timer = setTimeout(loop, everyMs);
    };
    void loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  };

  return {
    policy,
    status,
    nextInvoice,
    decide,
    read,
    tick,
    startAckLoop,
    idle: () => locked(async () => undefined), // resolves once queued work has finished
    state: () => state, // tests
  };
};

export type Session = Awaited<ReturnType<typeof createSession>>;
