import { z } from 'zod';

// Committed model measurements (backend/data: pass-rate-*.json from scripts/pass-rate.ts, the B1 summary) as served to the web.
// Pure: callers read the files. Every number is copied from the file, never recomputed.

const fraction = z.string().regex(/^\d+\/\d+$/);
const count = z.number().int().min(0);

const summaryRow = z.object({
  model: z.string().min(1).max(200),
  receipts: z.enum(['TEE', 'gateway']),
  trials: count,
  paid: count,
  proposed: count,
  declined: count,
  none: count,
  error: count,
  tried: count,
  genuinePaid: fraction,
  receiptsVerified: fraction,
  paidLurePayee: count.optional(), // realistic-policy runs only
  escalated: count.optional(),
});

const passRateFile = z.object({
  generated_at: z.iso.datetime(),
  lures: z.string().optional(), // present only when the run used generated lures (--lures)
  policy: z.enum(['strict', 'realistic']).optional(), // absent in runs before --policy: strict
  preflightMode: z.enum(['enforce', 'advisory']).optional(),
  trials: count,
  total_model_calls: count,
  summary: z.array(summaryRow).min(1),
  results: z.array(z.object({ model: z.string(), trials: z.array(z.object({ category: z.string().optional() })) })),
});

export interface ModelRow {
  model: string;
  receiptKind: 'TEE' | 'gateway';
  trials: number;
  declined: number;
  paid: number;
  proposed: number;
  noDecision: number;
  error: number;
  triedLurePayee: number;
  genuinePaid: number;
  genuineTotal: number;
  receiptsVerified: number;
  receiptsTotal: number;
  paidLurePayee?: number;
  escalated?: number;
}

export interface ModelRun {
  id: string;
  date: string; // UTC day of generated_at
  generatedAt: string;
  title: string;
  lureKind: 'scripted' | 'generated';
  policy: 'strict' | 'realistic'; // strict: unapproved payees are never paid; realistic: the model's judgment decides
  preflightMode: 'enforce' | 'advisory';
  categories: string[]; // lure pretexts in a generated run, sorted; empty for a scripted run
  trialsPerModel: number;
  totalCalls: number;
  models: ModelRow[];
}

const split = (f: string): [number, number] => {
  const [a, b] = f.split('/').map(Number);
  return [a, b];
};

/** One pass-rate JSON; its title comes from the run index, else from the run's own fields. Throws on an unknown shape. */
export const parsePassRate = (id: string, json: unknown, title?: string): ModelRun => {
  const d = passRateFile.parse(json);
  const lureKind = d.lures === undefined ? 'scripted' : 'generated';
  const categories = [...new Set(d.results.flatMap((r) => r.trials.map((t) => t.category).filter((c): c is string => !!c)))].sort();
  return {
    id,
    date: d.generated_at.slice(0, 10),
    generatedAt: d.generated_at,
    title: title ?? `Model pass rate on ${lureKind} lures${d.policy === 'realistic' ? ' under a realistic AP policy' : ''}`,
    lureKind,
    policy: d.policy ?? 'strict',
    preflightMode: d.preflightMode ?? 'enforce',
    categories: lureKind === 'generated' ? categories : [],
    trialsPerModel: d.trials,
    totalCalls: d.total_model_calls,
    models: d.summary.map((s) => {
      const [genuinePaid, genuineTotal] = split(s.genuinePaid);
      const [receiptsVerified, receiptsTotal] = split(s.receiptsVerified);
      return {
        model: s.model,
        receiptKind: s.receipts,
        trials: s.trials,
        declined: s.declined,
        paid: s.paid,
        proposed: s.proposed,
        noDecision: s.none,
        error: s.error,
        triedLurePayee: s.tried,
        genuinePaid,
        genuineTotal,
        receiptsVerified,
        receiptsTotal,
        ...(s.paidLurePayee !== undefined ? { paidLurePayee: s.paidLurePayee } : {}),
        ...(s.escalated !== undefined ? { escalated: s.escalated } : {}),
      };
    }),
  };
};

export interface B1Summary {
  run: string;
  judge: string;
  accuracy: number;
  wilsonLow: number;
  wilsonHigh: number;
  auc: number;
  n: number;
  limitAccuracy: number;
  limitAuc: number;
  date: string;
  pass: string;
  note: string;
}

const unit = z.number().min(0).max(1);
const b1File = z.strictObject({
  run: z.string().min(1).max(200),
  judge: z.string().min(1).max(200),
  accuracy: unit,
  wilsonLow: unit,
  wilsonHigh: unit,
  auc: unit,
  n: z.number().int().positive(),
  limitAccuracy: unit,
  limitAuc: unit,
  date: z.iso.date(),
  pass: z.string().min(1).max(100),
  note: z.string().max(500),
});

/** The B1 blind test's latest run (backend/data/b1-summary.json). Throws on an unknown shape. */
export const parseB1Summary = (json: unknown): B1Summary => b1File.parse(json);

/** Run titles by id (backend/data/model-runs/index.json). */
export const parseRunIndex = (json: unknown): Record<string, string> => z.strictObject({ titles: z.record(z.string(), z.string().min(1).max(200)) }).parse(json).titles;
