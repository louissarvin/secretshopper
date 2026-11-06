// NEAR AI usage and a rolling 24 h inference budget for the native agent. Pure apart from the injected save and log.

export const WINDOW_MS = 24 * 3_600_000;
const BUCKET_MS = 60_000; // one bucket per minute keeps the state file at most 1,440 entries

export interface UsageBucket {
  at: number; // ms, start of the minute
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens: number;
  cost_usd: number;
  max_call_tokens: number; // largest single call: the estimate for the next one
  max_call_cost_usd: number;
}
export type UsageWindow = { buckets: UsageBucket[] };
export const emptyUsage = (): UsageWindow => ({ buckets: [] });

/** Keeps only well-formed buckets inside the window; a state file is input, not trusted. */
export const loadUsage = (raw: unknown, nowMs: number): UsageWindow => {
  const list = (raw as { buckets?: unknown } | null)?.buckets;
  if (!Array.isArray(list)) return emptyUsage();
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const keys: (keyof UsageBucket)[] = ['at', 'calls', 'prompt_tokens', 'completion_tokens', 'tokens', 'cost_usd', 'max_call_tokens', 'max_call_cost_usd'];
  const buckets = list.filter((b): b is UsageBucket => !!b && typeof b === 'object' && keys.every((k) => num((b as Record<string, unknown>)[k])) && (b as UsageBucket).at > nowMs - WINDOW_MS);
  return { buckets: buckets.sort((a, b) => a.at - b.at) };
};

export interface Prices {
  inPerMTok: number; // USD per million prompt tokens; 0 = unknown
  outPerMTok: number;
}
export interface Budget {
  tokens: number; // per rolling 24 h; 0 = off
  costUsd: number;
}
export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined;

export class InferenceBudgetExhausted extends Error {
  constructor(readonly totals: Record<string, unknown>) {
    super('inference budget exhausted');
  }
}

type Log = { info: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void };

export const createMeter = (o: { window: UsageWindow; prices: Prices; budget: Budget; nowMs: () => number; save: () => Promise<void>; log: Log; statusEveryMs?: number }) => {
  const w = o.window;
  let exhausted = false;
  let lastStatus = 0;
  const prune = () => {
    const from = o.nowMs() - WINDOW_MS;
    while (w.buckets.length && w.buckets[0].at <= from) w.buckets.shift();
  };
  const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

  const totals = () => {
    prune();
    const t = { calls: 0, prompt_tokens: 0, completion_tokens: 0, tokens: 0, cost_usd: 0, max_call_tokens: 0, max_call_cost_usd: 0 };
    for (const b of w.buckets) {
      t.calls += b.calls;
      t.prompt_tokens += b.prompt_tokens;
      t.completion_tokens += b.completion_tokens;
      t.tokens += b.tokens;
      t.cost_usd += b.cost_usd;
      t.max_call_tokens = Math.max(t.max_call_tokens, b.max_call_tokens);
      t.max_call_cost_usd = Math.max(t.max_call_cost_usd, b.max_call_cost_usd);
    }
    return {
      ...t,
      cost_usd: round(t.cost_usd),
      budget_tokens: o.budget.tokens,
      budget_usd: o.budget.costUsd,
      price_known: o.prices.inPerMTok > 0 || o.prices.outPerMTok > 0,
      frees_at: w.buckets.length ? new Date(w.buckets[0].at + WINDOW_MS).toISOString() : null,
    };
  };

  return {
    totals,

    /** Throws before a model call that would cross a budget; the next call is estimated as the largest in the window. */
    check: (): void => {
      const t = totals();
      const over = (budget: number, used: number, next: number) => budget > 0 && (used >= budget || used + next > budget);
      if (over(o.budget.tokens, t.tokens, t.max_call_tokens) || over(o.budget.costUsd, t.cost_usd, t.max_call_cost_usd)) {
        if (!exhausted) o.log.warn('inference budget exhausted', { component: 'inference', ...t });
        exhausted = true;
        throw new InferenceBudgetExhausted(t);
      }
      exhausted = false;
    },

    /** Books one completion. A reply without usage counts as zero and is logged, never silently. */
    record: async (call: { model: string; invoice: string; step: number; id: string; usage: Usage }): Promise<void> => {
      const u = call.usage;
      const prompt = Math.max(0, Math.trunc(u?.prompt_tokens ?? 0));
      const completion = Math.max(0, Math.trunc(u?.completion_tokens ?? 0));
      const tokens = Math.max(prompt + completion, Math.trunc(u?.total_tokens ?? 0));
      const cost = (prompt * o.prices.inPerMTok + completion * o.prices.outPerMTok) / 1e6;
      const now = o.nowMs();
      const at = now - (now % BUCKET_MS);
      prune();
      let b = w.buckets.at(-1);
      if (!b || b.at !== at) {
        b = { at, calls: 0, prompt_tokens: 0, completion_tokens: 0, tokens: 0, cost_usd: 0, max_call_tokens: 0, max_call_cost_usd: 0 };
        w.buckets.push(b);
      }
      b.calls++;
      b.prompt_tokens += prompt;
      b.completion_tokens += completion;
      b.tokens += tokens;
      b.cost_usd += cost;
      b.max_call_tokens = Math.max(b.max_call_tokens, tokens);
      b.max_call_cost_usd = Math.max(b.max_call_cost_usd, cost);
      const line = { component: 'inference', model: call.model, invoice: call.invoice, step: call.step, completion_id: call.id, prompt_tokens: prompt, completion_tokens: completion, total_tokens: tokens, cost_usd: o.prices.inPerMTok || o.prices.outPerMTok ? round(cost) : null };
      if (u?.prompt_tokens === undefined || u?.completion_tokens === undefined) o.log.warn('model call without usage', line);
      else o.log.info('model call', line);
      await o.save();
    },

    /** The periodic status line; true when it logged. */
    maybeLogStatus: (): boolean => {
      const now = o.nowMs();
      if (!o.statusEveryMs || now - lastStatus < o.statusEveryMs) return false;
      lastStatus = now;
      o.log.info('inference usage 24h', { component: 'inference', ...totals() });
      return true;
    },
  };
};

export type Meter = ReturnType<typeof createMeter>;
