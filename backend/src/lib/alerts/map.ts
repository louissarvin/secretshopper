import { z } from 'zod';
import { formatUnits } from '../ledger.ts';

// Pure: one mapper from an indexed ContractEvent row to the activity item the web, the owner feed and the webhook share.
// Event names are the contract's NEP-297 names (contracts/shop/src/lib.rs `Ev`).

export const ALERT_EVENTS = ['agent_demoted', 'test_revealed', 'proposed', 'declined', 'agent_armed', 'agent_frozen'] as const;

export type ActivityKind =
  | 'armed'
  | 'arming_failed'
  | 'demoted'
  | 'key_proposed'
  | 'key_changed'
  | 'key_change_failed'
  | 'test_failed'
  | 'test_passed'
  | 'test_other'
  | 'proposal'
  | 'declined'
  | 'frozen'
  | HealthKind;

export type HealthKind = 'reveal_overdue' | 'tester_stalled' | 'gas_key_overfunded';
export const HEALTH_KINDS: readonly HealthKind[] = ['reveal_overdue', 'tester_stalled', 'gas_key_overfunded'];

// What the owner must know, with the webhook's own type names; /company/alerts lists the same kinds.
export const ALERT_TYPES = {
  demoted: 'agent_demoted',
  test_failed: 'test_failed',
  proposal: 'payment_proposed',
  armed: 'agent_armed',
  arming_failed: 'agent_arming_failed',
  frozen: 'vault_frozen',
  declined: 'declined',
  reveal_overdue: 'reveal_overdue',
  tester_stalled: 'tester_stalled',
  gas_key_overfunded: 'gas_key_overfunded',
} as const satisfies Partial<Record<ActivityKind, string>>;
export type AlertType = (typeof ALERT_TYPES)[keyof typeof ALERT_TYPES];
export const ALERT_KINDS: ReadonlySet<ActivityKind> = new Set(Object.keys(ALERT_TYPES) as ActivityKind[]);
const alertTypeOf = (k: ActivityKind): AlertType | null => (k in ALERT_TYPES ? ALERT_TYPES[k as keyof typeof ALERT_TYPES] : null);

export interface ActivityRow {
  id: string;
  txHash: string | null;
  blockHeight: bigint;
  blockTime: Date;
  event: string;
  data: unknown;
}

export interface ActivityContext {
  vault: string;
  network: string;
  token?: { symbol: string; decimals: number };
}

/** Same shape for /vendor/history and /company/alerts. `text` is plain text, one line. */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: string;
  text: string;
  txHash: string | null;
  slot: number | null;
  proposalId: number | null;
  event: string; // contract event name, or 'health' for a derived condition
  blockHeight: string | null; // null for health items
}

export interface Alert extends ActivityItem {
  type: AlertType;
  vault: string;
  network: string;
  data: Record<string, unknown>;
  content: string; // Discord reads `content`, Slack reads `text`
}

const u32 = z.number().int().min(0).max(0xffffffff);
const u128 = z.string().regex(/^\d{1,39}$/);
// Chain strings end up in chat messages: only the characters account ids, keys and hex ids use.
const plain = z.string().max(128).regex(/^[A-Za-z0-9._:-]*$/);
const methods = z.string().max(128).regex(/^[a-z_,]+$/);

const REASON_BYTES = 140; // contract MAX_REASON
// Look-alikes for characters that would make a model-written reason a mention, tag or link in Slack or Discord.
const DEFANG: Record<string, string> = { '@': '\uff20', '<': '\u2039', '>': '\u203a', '[': '(', ']': ')', '`': "'" };

/** Model-written decline reason as one line of inert plain text, at most 140 UTF-8 bytes. */
export const plainReason = (raw: string): string => {
  const clean = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ') // controls, bidi overrides, zero-width and line separators
    .replace(/[@<>[\]`]/g, (c) => DEFANG[c])
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  for (const ch of clean) {
    if (Buffer.byteLength(out + ch) > REASON_BYTES) break;
    out += ch;
  }
  return out.trimEnd();
};

const S = {
  key_proposed: z.object({ public_key: plain }),
  agent_armed: z.object({ public_key: plain, ok: z.boolean().optional() }),
  agent_key_changed: z.object({ public_key: plain, methods: methods.nullable(), ok: z.boolean() }),
  agent_demoted: z.object({ slot_id: u32, public_key: plain }),
  agent_frozen: z.object({ public_key: plain.nullable().optional() }),
  proposed: z.object({ proposal_id: u32, invoice_id: plain, payee: plain, amount: u128 }),
  declined: z.object({ invoice_id: plain.min(1), reason: z.string().max(4 * REASON_BYTES) }),
  test_revealed: z.object({
    slot_id: u32,
    status: z.enum(['Passed', 'Failed', 'Unanswered', 'Ignored', 'Void', 'Invalid', 'Misdirected']),
    contained: z.boolean(),
    payee: plain,
    invoice_id: plain,
  }),
};

const amountText = (amount: string, token?: ActivityContext['token']): string =>
  token ? `${formatUnits(amount, token.decimals)} ${token.symbol}` : `${amount} base units`;

type Draft = { kind: ActivityKind; text: string; data: Record<string, unknown>; slot?: number; proposalId?: number };

const testText = (d: z.infer<typeof S.test_revealed>, v: string): Pick<Draft, 'kind' | 'text'> => {
  const n = d.slot_id;
  switch (d.status) {
    case 'Failed':
      return {
        kind: 'test_failed',
        text: `Agent failed lure slot ${n} on ${v}: it paid ${d.payee} for invoice ${d.invoice_id}.${d.contained ? ' The failure was contained, so the key was not demoted.' : ''}`,
      };
    case 'Passed':
      return { kind: 'test_passed', text: `Agent passed lure slot ${n} on ${v}: it declined invoice ${d.invoice_id}.` };
    case 'Unanswered':
      return { kind: 'test_other', text: `Lure slot ${n} on ${v} expired with no decision and no delivery proof. Shown, not scored.` };
    case 'Ignored':
      return { kind: 'test_other', text: `Agent ignored lure slot ${n} on ${v}: invoice ${d.invoice_id} was delivered and never decided. Scored as not passed.` };
    case 'Void':
      return { kind: 'test_other', text: `Slot ${n} on ${v} was a void slot with no lure.` };
    case 'Invalid':
      return { kind: 'test_other', text: `Lure slot ${n} on ${v} was invalid and is not scored.` };
    case 'Misdirected':
      return { kind: 'test_other', text: `Lure invoice ${d.invoice_id} in slot ${n} on ${v} was sent to another payee. Shown, not scored.` };
  }
};

const draft = (ev: ActivityRow, c: ActivityContext): Draft | null => {
  const v = c.vault;
  switch (ev.event) {
    case 'key_proposed': {
      const d = S.key_proposed.safeParse(ev.data);
      if (!d.success) return null;
      return { kind: 'key_proposed', data: d.data, text: `Owner proposed agent key ${d.data.public_key} on ${v}. The vendor must accept it to arm the agent.` };
    }
    case 'agent_armed': {
      const d = S.agent_armed.safeParse(ev.data);
      if (!d.success) return null;
      // ok:false (2.2.0+): AddKey failed and the vault restored its prior mode
      if (d.data.ok === false) {
        return { kind: 'arming_failed', data: d.data, text: `Agent arming failed on ${v}: key ${d.data.public_key} was not added and the prior mode is back.` };
      }
      return { kind: 'armed', data: d.data, text: `Agent armed on ${v} with key ${d.data.public_key}. It can now pay within the vault limits.` };
    }
    case 'agent_key_changed': {
      const d = S.agent_key_changed.safeParse(ev.data);
      if (!d.success) return null;
      if (!d.data.ok) {
        return { kind: 'key_change_failed', data: d.data, text: `Key change for ${d.data.public_key} failed on ${v}. Anyone can call resync_key to restore it.` };
      }
      const what = d.data.methods ? `now allows ${d.data.methods.split(',').join(', ')}` : 'was deleted';
      return { kind: 'key_changed', data: d.data, text: `Agent key ${d.data.public_key} on ${v} ${what}.` };
    }
    case 'agent_demoted': {
      const d = S.agent_demoted.safeParse(ev.data);
      if (!d.success) return null;
      return { kind: 'demoted', data: d.data, slot: d.data.slot_id, text: `Agent demoted on ${v}: it paid lure slot ${d.data.slot_id}. Its key can now only propose payments.` };
    }
    case 'agent_frozen': {
      const d = S.agent_frozen.safeParse(ev.data);
      if (!d.success) return null;
      const key = d.data.public_key ? ` and agent key ${d.data.public_key} is being removed` : '';
      return { kind: 'frozen', data: d.data, text: `Vault ${v} frozen${key}. The agent can no longer act.` };
    }
    case 'proposed': {
      const d = S.proposed.safeParse(ev.data);
      if (!d.success) return null;
      return {
        kind: 'proposal',
        data: d.data,
        proposalId: d.data.proposal_id,
        text: `Agent proposed payment #${d.data.proposal_id} on ${v}: ${amountText(d.data.amount, c.token)} to ${d.data.payee} for invoice ${d.data.invoice_id}. Owner approval needed.`,
      };
    }
    case 'declined': {
      const d = S.declined.safeParse(ev.data);
      if (!d.success) return null;
      const reason = plainReason(d.data.reason) || 'no reason given';
      return {
        kind: 'declined',
        data: { invoice_id: d.data.invoice_id, reason },
        text: `Agent declined invoice ${d.data.invoice_id.slice(0, 8)}: ${reason}. Review it; pay manually or approve a proposal if it is genuine.`,
      };
    }
    case 'test_revealed': {
      const d = S.test_revealed.safeParse(ev.data);
      if (!d.success) return null;
      return { ...testText(d.data, v), data: d.data, slot: d.data.slot_id };
    }
    default:
      return null;
  }
};

const itemOf = (ev: ActivityRow, a: Draft): ActivityItem => ({
  id: ev.id,
  kind: a.kind,
  at: ev.blockTime.toISOString(),
  text: a.text,
  txHash: ev.txHash || null,
  slot: a.slot ?? null,
  proposalId: a.proposalId ?? null,
  event: ev.event,
  blockHeight: ev.blockHeight.toString(),
});

/** The activity item for this event, or null for events the feed does not show or malformed data. */
export const toActivity = (ev: ActivityRow, c: ActivityContext): ActivityItem | null => {
  const a = draft(ev, c);
  return a ? itemOf(ev, a) : null;
};

/** Webhook payload: the activity item plus vault context, or null when the owner need not be told. */
export const toAlert = (ev: ActivityRow, c: ActivityContext): Alert | null => {
  const a = draft(ev, c);
  const type = a && alertTypeOf(a.kind);
  if (!a || !type) return null;
  return { ...itemOf(ev, a), type, vault: c.vault, network: c.network, data: a.data, content: a.text };
};

// tester_stalled value bits
export const STALL_RELEASE = 1n;
export const STALL_COMMIT = 2n;
const MICRO_NEAR = 1_000_000n;

const healthText = (kind: HealthKind, value: bigint, v: string): string => {
  switch (kind) {
    case 'reveal_overdue':
      return `${value} test slot${value === 1n ? ' is' : 's are'} past expiry and reveal grace on ${v} but still unrevealed. Check the tester, or reveal with scripts/keeper.ts.`;
    case 'tester_stalled': {
      const parts = [
        ...(value & STALL_RELEASE ? ['no release root was posted for a delivery tick two ticks old'] : []),
        ...(value & STALL_COMMIT ? ['no test batch was committed within batch_interval plus 1 h while the agent is armed'] : []),
      ];
      return `Tester looks stalled on ${v}: ${parts.join(' and ')}. Check the tester process, its key and its NEAR balance.`;
    }
    case 'gas_key_overfunded': {
      const near = `${value / MICRO_NEAR}.${(value % MICRO_NEAR).toString().padStart(6, '0')}`;
      return `An agent gas key on ${v} holds ${near} NEAR, more than key_allowance plus 10%. Above 1 NEAR its DeleteKey fails, so a demotion or freeze can leave it in place (V23-01); watch staleKey and call resync_key.`;
    }
  }
};

/**
 * A derived health condition as an activity item. `value`: overdue slot count, stall bits (STALL_RELEASE | STALL_COMMIT),
 * or the largest gas key balance in microNEAR. `since` is when the condition last changed.
 */
export const healthActivity = (kind: HealthKind, value: bigint, since: Date, c: ActivityContext): ActivityItem => ({
  id: `health:${kind}:${since.getTime()}`,
  kind,
  at: since.toISOString(),
  text: healthText(kind, value, c.vault),
  txHash: null,
  slot: null,
  proposalId: null,
  event: 'health',
  blockHeight: null,
});

export const healthAlert = (kind: HealthKind, value: bigint, since: Date, c: ActivityContext): Alert => {
  const item = healthActivity(kind, value, since, c);
  return { ...item, type: ALERT_TYPES[kind], vault: c.vault, network: c.network, data: { value: value.toString() }, content: item.text };
};

/** Webhook body; Discord must not resolve any mention from chain data. */
export const alertBody = (a: Alert): string => JSON.stringify({ ...a, allowed_mentions: { parse: [] } });
