import { z } from 'zod';

// The committed result of `bun run verify` (scripts/verify-all.ts) as served to the web. Pure: callers read the file.
// Counts come only from the summary lines of steps that passed; anything not parseable is null.

const stepSchema = z.object({
  step: z.string().min(1).max(200),
  status: z.enum(['pass', 'fail', 'skip']),
  seconds: z.number().min(0),
  summary: z.string().max(2000),
});

// verify-all.ts writes ranAt and results; generatedAt and steps are accepted as the same fields
const reportSchema = z
  .object({
    ranAt: z.iso.datetime().optional(),
    generatedAt: z.iso.datetime().optional(),
    platform: z.string().max(100).optional(),
    bun: z.string().max(50).optional(),
    results: z.array(stepSchema).max(100).optional(),
    steps: z.array(stepSchema).max(100).optional(),
  })
  .refine((r) => !!(r.results ?? r.steps), 'no steps');

export type VerifyStep = z.infer<typeof stepSchema>;

export interface VerifyCounts {
  contractUnit: number | null;
  contractAudit: number | null;
  contractCost: number | null;
  contractSandbox: number | null;
  backendPass: number | null;
  backendSkip: number | null;
  backendFail: number | null;
  agentPass: number | null;
  agentFail: number | null;
  demoChecks: number | null;
  mcpChecks: number | null;
}

export interface VerifyReport {
  generatedAt: string | null;
  platform: string | null;
  bun: string | null;
  codeHash: string | null; // contract wasm hash from the build step ("SHA-256 checksum bs58: X")
  ok: boolean; // every step passed or was skipped
  passed: number;
  failed: number;
  skipped: number;
  steps: VerifyStep[];
  counts: VerifyCounts;
}

const one = (re: RegExp, s: string | undefined): number | null => {
  const m = s?.match(re);
  return m ? Number(m[1]) : null;
};

/** bun test prints "N pass" and "N fail" always and "N skip" only when something was skipped. */
const bunCounts = (s: string | undefined) => {
  const pass = one(/(?:^|; ) *(\d+) pass\b/, s);
  const fail = one(/(?:^|; ) *(\d+) fail\b/, s);
  const skip = one(/(?:^|; ) *(\d+) skip\b/, s);
  return { pass, fail, skip: skip ?? (pass !== null && fail !== null ? 0 : null) };
};

export const parseVerifyReport = (json: unknown): VerifyReport => {
  const r = reportSchema.parse(json);
  const steps = (r.results ?? r.steps)!;
  const summaryOf = (re: RegExp) => steps.find((s) => s.status === 'pass' && re.test(s.step))?.summary;

  // cargo prints one "test result" per target in this order: lib (unit), tests/audit_v21, tests/costs, tests/sandbox, doc-tests
  const cargo = [...(summaryOf(/^contract tests\b/) ?? '').matchAll(/test result: ok\. (\d+) passed/g)].map((m) => Number(m[1]));
  const [unit, audit, cost, sandbox] = cargo.length >= 4 ? cargo : [null, null, null, null];
  const backend = bunCounts(summaryOf(/^backend tests$/));
  const agent = bunCounts(summaryOf(/^agent tests$/));
  const checks = /PASS: all (\d+) checks held/;

  return {
    generatedAt: r.generatedAt ?? r.ranAt ?? null,
    platform: r.platform ?? null,
    bun: r.bun ?? null,
    codeHash: summaryOf(/^contract wasm build\b/)?.match(/SHA-256 checksum bs58: ([1-9A-HJ-NP-Za-km-z]{43,44})\b/)?.[1] ?? null,
    ok: steps.every((s) => s.status !== 'fail'),
    passed: steps.filter((s) => s.status === 'pass').length,
    failed: steps.filter((s) => s.status === 'fail').length,
    skipped: steps.filter((s) => s.status === 'skip').length,
    steps,
    counts: {
      contractUnit: unit,
      contractAudit: audit,
      contractCost: cost,
      contractSandbox: sandbox,
      backendPass: backend.pass,
      backendSkip: backend.skip,
      backendFail: backend.fail,
      agentPass: agent.pass,
      agentFail: agent.fail,
      demoChecks: one(checks, summaryOf(/^end-to-end demo\b/)),
      mcpChecks: one(checks, summaryOf(/\bMCP\b/)),
    },
  };
};
