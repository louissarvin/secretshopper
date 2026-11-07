import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import { emptyAckState } from '../src/acks.ts';
import { createInbox, type InboxItem, type State } from '../src/inboxClient.ts';
import { runItem } from '../src/item.ts';
import type { ChatClient } from '../src/llm.ts';
import { createAgentLoop } from '../src/loop.ts';
import { createMeter, emptyUsage, InferenceBudgetExhausted, loadUsage, WINDOW_MS, type Budget, type Prices, type UsageWindow } from '../src/usage.ts';

const T0 = Date.parse('2026-11-12T08:00:30.000Z');
const ITEM: InboxItem = { id: 'd'.repeat(64), receivedAt: '2026-11-12T08:00:00.000Z', email: {}, document: {} };

const meterFor = (o: { budget?: Partial<Budget>; prices?: Partial<Prices>; window?: UsageWindow; status?: number } = {}) => {
  let now = T0;
  const lines: { level: string; msg: string; f: Record<string, unknown> }[] = [];
  let saves = 0;
  const window = o.window ?? emptyUsage();
  const meter = createMeter({
    window,
    prices: { inPerMTok: 0, outPerMTok: 0, ...o.prices },
    budget: { tokens: 0, costUsd: 0, ...o.budget },
    nowMs: () => now,
    save: async () => void saves++,
    log: { info: (msg, f = {}) => lines.push({ level: 'info', msg, f }), warn: (msg, f = {}) => lines.push({ level: 'warn', msg, f }) },
    statusEveryMs: o.status,
  });
  const call = (prompt: number, completion: number, id = 'c') => meter.record({ model: 'm', invoice: ITEM.id, step: 0, id, usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });
  return { meter, window, lines, call, saves: () => saves, setNow: (t: number) => (now = t) };
};

describe('inference usage', () => {
  test('accumulates tokens and cost and logs one inference line per call', async () => {
    const m = meterFor({ prices: { inPerMTok: 0.5, outPerMTok: 2 } });
    await m.call(1000, 200, 'c1');
    m.setNow(T0 + 90_000); // next minute bucket
    await m.call(3000, 800, 'c2');
    expect(m.meter.totals()).toMatchObject({ calls: 2, prompt_tokens: 4000, completion_tokens: 1000, tokens: 5000, cost_usd: 0.004, max_call_tokens: 3800, price_known: true });
    expect(m.window.buckets.length).toBe(2);
    expect(m.lines.map((l) => [l.msg, l.f.component, l.f.completion_id, l.f.total_tokens, l.f.cost_usd])).toEqual([
      ['model call', 'inference', 'c1', 1200, 0.0009],
      ['model call', 'inference', 'c2', 3800, 0.0031],
    ]);
    expect(m.saves()).toBe(2); // every call is persisted
  });

  test('unknown prices log a null cost; a reply without usage is a warning and counts zero', async () => {
    const m = meterFor();
    await m.call(10, 5);
    expect(m.lines[0].f.cost_usd).toBeNull();
    await m.meter.record({ model: 'm', invoice: ITEM.id, step: 1, id: 'x', usage: undefined });
    expect(m.lines[1]).toMatchObject({ level: 'warn', msg: 'model call without usage' });
    expect(m.meter.totals()).toMatchObject({ calls: 2, tokens: 15 });
  });

  test('the 24 h window survives a restart through the state file and prunes old minutes', async () => {
    const m = meterFor({ prices: { inPerMTok: 1, outPerMTok: 1 } });
    await m.call(1000, 0);
    m.setNow(T0 + 3_600_000);
    await m.call(500, 0);
    const inbox = createInbox({ url: 'https://inbox.example.com', token: 't', stateFile: join(mkdtempSync(join(tmpdir(), 'usage-')), 's.json') });
    await inbox.saveState({ cursor: null, attempts: {}, acks: emptyAckState(), inference: m.window });
    const raw = (await inbox.loadState()).inference;
    // restart just inside the window: both calls still count
    expect(meterFor({ window: loadUsage(raw, T0 + WINDOW_MS - 60_000) }).meter.totals().tokens).toBe(1500);
    // past 24 h after the first call: only the second remains, and the restored meter keeps pruning
    const later = meterFor({ window: loadUsage(raw, T0 + WINDOW_MS + 60_000) });
    later.setNow(T0 + WINDOW_MS + 60_000);
    expect(later.meter.totals()).toMatchObject({ calls: 1, tokens: 500 });
    later.setNow(T0 + 3_600_000 + WINDOW_MS + 60_000);
    expect(later.meter.totals().calls).toBe(0);
    // a tampered state file cannot inject negative or malformed entries
    expect(loadUsage({ buckets: [{ at: T0, calls: 1, prompt_tokens: -5, completion_tokens: 0, tokens: -5, cost_usd: 0, max_call_tokens: 0, max_call_cost_usd: 0 }, 'x', null] }, T0).buckets).toEqual([]);
    expect(loadUsage(undefined, T0)).toEqual(emptyUsage());
  });
});

describe('inference budget', () => {
  test('stops before the call that would cross the token budget, logs once, frees with the window', async () => {
    const m = meterFor({ budget: { tokens: 1000 } });
    m.meter.check();
    await m.call(400, 200); // 600; the next call is estimated at 600
    expect(() => m.meter.check()).toThrow(InferenceBudgetExhausted);
    expect(() => m.meter.check()).toThrow(InferenceBudgetExhausted);
    const warns = m.lines.filter((l) => l.msg === 'inference budget exhausted');
    expect(warns.length).toBe(1);
    expect(warns[0].f).toMatchObject({ component: 'inference', tokens: 600, budget_tokens: 1000, frees_at: new Date(T0 - (T0 % 60_000) + WINDOW_MS).toISOString() });
    m.setNow(T0 + WINDOW_MS);
    expect(() => m.meter.check()).not.toThrow();
  });

  test('a cost budget counts dollars at the configured prices', async () => {
    const m = meterFor({ budget: { costUsd: 0.01 }, prices: { inPerMTok: 1, outPerMTok: 4 } });
    await m.call(2000, 1000); // 0.006
    expect(() => m.meter.check()).toThrow(InferenceBudgetExhausted); // 0.006 + 0.006 > 0.01
  });

  test('budgets off by default: no stop however much is used', async () => {
    const m = meterFor();
    for (let i = 0; i < 5; i++) await m.call(10_000_000, 10_000_000);
    expect(() => m.meter.check()).not.toThrow();
  });

  test('the status line is logged every N minutes', () => {
    const m = meterFor({ status: 600_000 });
    expect(m.meter.maybeLogStatus()).toBe(true);
    m.setNow(T0 + 599_999);
    expect(m.meter.maybeLogStatus()).toBe(false);
    m.setNow(T0 + 600_000);
    expect(m.meter.maybeLogStatus()).toBe(true);
    expect(m.lines.filter((l) => l.msg === 'inference usage 24h').length).toBe(2);
    expect(meterFor().meter.maybeLogStatus()).toBe(false);
  });
});

const reply = (id: string, usage = { prompt_tokens: 700, completion_tokens: 100, total_tokens: 800 }) =>
  ({
    id,
    object: 'chat.completion',
    created: 0,
    model: 'm',
    usage,
    choices: [{ index: 0, finish_reason: 'tool_calls', logprobs: null, message: { role: 'assistant', content: null, refusal: null, tool_calls: [{ id: `t-${id}`, type: 'function', function: { name: 'get_vendor', arguments: '{}' } }] } }],
  }) as OpenAI.Chat.ChatCompletion;

describe('budget in the decision loop and index.ts', () => {
  test('the loop books each call and makes no model call once the budget is spent', async () => {
    const m = meterFor({ budget: { tokens: 2000 } });
    let created = 0;
    const llm: ChatClient = { chat: { completions: { create: (async () => (created++, reply(`r${created}`))) as unknown as ChatClient['chat']['completions']['create'] } } };
    const tools: string[] = [];
    const loop = createAgentLoop({ llm, verify: async (id) => ({ id, signature_kind: 'provider_tee', signing_algo: 'ed25519', signer: 's', tcb_status: 'UpToDate' }), model: 'm', maxSteps: 6, meter: m.meter });
    // 800 per call: the third would reach 2400
    await expect(loop(ITEM, 'Armed', 'Co', async (name) => (tools.push(name), { final: false, output: {} }), false)).rejects.toThrow(InferenceBudgetExhausted);
    expect(created).toBe(2);
    expect(tools).toEqual(['get_vendor', 'get_vendor']);
    expect(m.meter.totals().tokens).toBe(1600);
    // next invoice: no model call at all, no tool, nothing signed
    await expect(loop({ ...ITEM, id: 'e'.repeat(64) }, 'Armed', 'Co', async (name) => (tools.push(name), { final: true, output: {} }), false)).rejects.toThrow(InferenceBudgetExhausted);
    expect(created).toBe(2);
    expect(tools.length).toBe(2);
  });

  test('runItem: a spent budget holds the cursor, spends no attempt and adds nothing to the ack', async () => {
    const state: State = { cursor: null, attempts: {}, acks: emptyAckState() };
    const advanced: unknown[] = [];
    let saved = 0;
    const base = {
      item: ITEM,
      state,
      advance: async (_s: State, i: InboxItem, opts?: { ack: boolean }) => void advanced.push([i.id, opts?.ack ?? true]),
      saveState: async () => void saved++,
      maxAttempts: 3,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const out = await runItem({ ...base, process: () => Promise.reject(new InferenceBudgetExhausted({})) });
    expect(out).toBe('budget');
    expect(advanced).toEqual([]);
    expect(state.attempts).toEqual({});
    expect(state.cursor).toBeNull();
    expect(state.acks).toEqual(emptyAckState());
    expect(saved).toBe(0);
    // other failures keep the AG-03 rules: retry, then give up out of the ack
    const fail = () => Promise.reject(new Error('rpc down'));
    expect(await runItem({ ...base, process: fail })).toBe('retry');
    expect(await runItem({ ...base, process: fail })).toBe('retry');
    expect(await runItem({ ...base, process: fail })).toBe('given_up');
    expect(advanced).toEqual([[ITEM.id, false]]);
    expect(await runItem({ ...base, process: async () => ({ decided: true, tool: 'decline', steps: 1, calls: [], receipts: [] }) })).toBe('processed');
    expect(advanced).toEqual([[ITEM.id, false], [ITEM.id, true]]);
  });
});

describe('budget config', () => {
  const SRC = join(import.meta.dir, '..', 'src', 'config.ts');
  const BASE = { PATH: process.env.PATH ?? '', AGENT_VAULT_ID: 'v.testnet', AGENT_PRIVATE_KEY: 'ed25519:x', INBOX_URL: 'https://inbox.example.com', INBOX_TOKEN: 't', NEARAI_API_KEY_AGENT: 'k' };
  const run = (env: Record<string, string>) => {
    const r = Bun.spawnSync([process.execPath, '-e', `const c = await import(${JSON.stringify(SRC)}); console.log(JSON.stringify([c.PRICE_IN_PER_MTOK, c.DAILY_TOKEN_BUDGET, c.DAILY_COST_BUDGET_USD, c.USAGE_STATUS_MIN]))`], { cwd: mkdtempSync(join(tmpdir(), 'usage-cfg-')), env: { ...BASE, ...env } });
    return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
  };

  test('defaults are off; prices are bounded decimals; a cost budget needs a price', () => {
    expect(JSON.parse(run({}).out.trim())).toEqual([0, 0, 0, 60]);
    expect(JSON.parse(run({ AGENT_PRICE_IN_PER_MTOK: '0.15', AGENT_DAILY_COST_BUDGET_USD: '2.5' }).out.trim())).toEqual([0.15, 0, 2.5, 60]);
    for (const [k, v, msg] of [
      ['AGENT_PRICE_IN_PER_MTOK', '-1', 'must be a number'],
      ['AGENT_PRICE_OUT_PER_MTOK', '1e3', 'must be a number'],
      ['AGENT_PRICE_IN_PER_MTOK', '1001', 'must be a number'],
      ['AGENT_DAILY_TOKEN_BUDGET', '1.5', 'must be an integer'],
      ['AGENT_USAGE_STATUS_MIN', '0', 'must be an integer'],
      ['AGENT_DAILY_COST_BUDGET_USD', '5', 'needs AGENT_PRICE_IN_PER_MTOK'],
    ]) {
      const r = run({ [k]: v });
      expect(r.ok).toBe(false);
      expect(r.out).toContain(msg);
    }
  });
});
