import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { releaseAtNs, TICK_SETTLE_MS } from '../src/acks.ts';
import { createInbox, MAX_INBOX_BYTES, type Fetch } from '../src/inboxClient.ts';
import { merkleRootHex } from '../src/merkle.ts';
import { acquireStateLock, AGENT_DIR, agentPath, assertNoNativeAgent, CONCURRENT_WINDOW_MS, preflightMode } from '../src/mcp/config.ts';
import { createMcpServer, POLICY_URI, SERVER_NAME } from '../src/mcp/server.ts';
import { createSession, mcpPolicy, TOO_LARGE } from '../src/mcp/session.ts';
import { POLICY } from '../src/policy.ts';
import { createRunTool, MAX_SIGNS_PER_INVOICE, OUT_OF_SIGNS, type AccountFacts, type Mode, type PreflightMode, type ToolDeps } from '../src/tools.ts';
import type { Release, Status } from '../src/vault.ts';
import { NOW, recorder } from './recorder.ts';

const KEY = 'ed25519:agentkey';
const T0 = Date.parse('2026-11-12T08:00:00.000Z');
const TICK = 120 * 60_000;
const id = (n: number) => n.toString(16).padStart(64, '0');
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const lure = (account: string): AccountFacts => ({
  account_id: account,
  exists: false,
  hasContract: false,
  contract: null,
  code_history: null,
  first_seen_by_vault: null,
  first_tx_at: null,
  approved_payee: null,
});

// Inbox API stand-in with the /inbox/next rules: ordered by (receivedAt, id), cursor exclusive.
const inboxApi = (rows: { id: string; at: number }[], o: { oversize?: boolean; padBytes?: Record<string, number> } = {}) => {
  const hits: string[] = [];
  const fetch: Fetch = async (url) => {
    const u = new URL(url);
    hits.push(u.pathname);
    if (o.oversize) return new Response(JSON.stringify({ success: true, data: null, pad: 'x'.repeat(MAX_INBOX_BYTES) }));
    if (u.pathname.endsWith('/next')) {
      const afterAt = u.searchParams.get('afterAt');
      const afterId = u.searchParams.get('afterId') ?? '';
      const r = rows
        .slice()
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
        .find((x) => !afterAt || x.at > Date.parse(afterAt) || (x.at === Date.parse(afterAt) && x.id > afterId));
      const data = r ? { id: r.id, receivedAt: new Date(r.at).toISOString(), email: { from: 'billing@acme.example' }, document: { total: '1.37', ...(o.padBytes?.[r.id] ? { notes: 'x'.repeat(o.padBytes[r.id]) } : {}) } } : null;
      return new Response(JSON.stringify({ success: true, data }));
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch, hits };
};

const setup = async (o: { mode?: Mode; rows?: { id: string; at: number }[]; oversize?: boolean; deps?: Partial<ToolDeps>; decided?: string[]; intents?: boolean; timeoutMs?: number; maxCalls?: number; maxResultBytes?: number; padBytes?: Record<string, number>; preflight?: PreflightMode } = {}) => {
  const rec = recorder(o.deps);
  const status: Status = { mode: o.mode ?? 'Armed', agent_key: KEY, pending_key: null, armed_at: '0', spent_24h: '250000', owner_id: 'owner.testnet', vendor_id: 'vendor.testnet', token_id: 'usdc.testnet', intents_id: null, version: '2.3.0' };
  const releases = new Map<string, Release>();
  const acks: string[] = [];
  const decided = new Set(o.decided ?? []);
  const api = inboxApi(o.rows ?? [{ id: id(1), at: T0 }, { id: id(2), at: T0 }], { oversize: o.oversize, padBytes: o.padBytes });
  const inbox = createInbox({ url: 'https://inbox.example.com/inbox', token: 't', stateFile: join(mkdtempSync(join(tmpdir(), 'mcp-state-')), 's.json'), fetch: api.fetch });
  let now = NOW;
  const session = await createSession({
    vault: {
      getStatus: async () => ({ ...status }),
      getPolicy: async () => ({ max_per_payment: '2000000', daily_cap: '5000000', max_payments_per_day: 10, max_new_payees_per_day: 2, max_decisions_per_day: 50, key_nonces: 4 }),
      getDecision: async (inv) => (decided.has(inv) ? { decided: true } : null),
      getRelease: async (at) => releases.get(at) ?? null,
      ack: async (at, root) => {
        const r = releases.get(at)!;
        r.ack = { root, at: '0', key: KEY };
        acks.push(`${at}:${root}`);
        return { txHash: `ack${acks.length}` };
      },
      publicKey: () => KEY,
    },
    inbox,
    runTool: createRunTool({ ...rec.deps, preflightMode: o.preflight }),
    vaultId: 'shop.owner.testnet',
    company: 'Northwind',
    intentsEnabled: o.intents ?? false,
    tokenDecimals: 6,
    listedOnly: true,
    preflightMode: o.preflight ?? 'enforce',
    decisionTimeoutMs: o.timeoutMs ?? 1_800_000,
    maxToolCallsPerInvoice: o.maxCalls ?? 20,
    maxResultBytes: o.maxResultBytes ?? 45_000,
    nowMs: () => now,
    log: silent,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(session, { intentsEnabled: o.intents ?? false, preflightMode: o.preflight }), { transport: serverT });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
    let out: Record<string, unknown>;
    try {
      out = JSON.parse(text);
    } catch {
      out = { raw: text };
    }
    return { isError: r.isError === true, out };
  };
  return { ...rec, status, session, client, call, api, releases, acks, decided, setNow: (t: number) => (now = t) };
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const money = (invoice_id: string, payee: string, amount_usdc = '1.37') => ({ invoice_id, payee, amount_usdc, rail: 'Near' });

describe('MCP server: surface', () => {
  test('lists exactly the agent tools with strict input schemas, and the policy', async () => {
    const h = await setup();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['check_account', 'decline', 'get_status', 'get_vendor', 'next_invoice', 'pay', 'propose']);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['pay', 'propose']) {
      const s = by[name].inputSchema as unknown as { required: string[]; additionalProperties: boolean; properties: Record<string, { enum?: string[] }> };
      expect(s.required.sort()).toEqual(['amount_usdc', 'invoice_id', 'payee', 'rail']);
      expect(s.additionalProperties).toBe(false);
      expect(s.properties.rail.enum).toEqual(['Near']);
    }
    expect((by.decline.inputSchema as { required: string[] }).required.sort()).toEqual(['invoice_id', 'reason']);
    expect((by.get_vendor.inputSchema as { required: string[] }).required).toEqual(['vendor_id']);
    expect((by.check_account.inputSchema as { required: string[] }).required).toEqual(['account_id']);
    expect(by.next_invoice.inputSchema.required ?? []).toEqual([]);
    expect(by.get_status.annotations?.readOnlyHint).toBe(true);
    expect(by.pay.annotations?.destructiveHint).toBe(true);
    // the external model gets the policy our own model gets
    const rule1 = POLICY.split('\n')[2];
    for (const name of ['next_invoice', 'pay', 'propose', 'decline']) expect(by[name].description).toContain(rule1);
    expect(h.client.getInstructions()).toContain(mcpPolicy('Northwind'));
    expect(h.client.getServerVersion()?.name).toBe(SERVER_NAME);
    const res = await h.client.readResource({ uri: POLICY_URI });
    expect((res.contents[0] as { text: string }).text).toBe(mcpPolicy('Northwind'));
  });

  test('the Intents rail is offered only when the vault has it', async () => {
    const h = await setup({ intents: true });
    const pay = (await h.client.listTools()).tools.find((t) => t.name === 'pay')!;
    expect((pay.inputSchema.properties as Record<string, { enum?: string[] }>).rail.enum).toEqual(['Near', 'Intents']);
  });

  test('get_status reports mode, key kind and methods, and limits in both units', async () => {
    const h = await setup({ mode: 'Demoted' });
    const { out } = await h.call('get_status');
    expect(out).toMatchObject({
      mode: 'Demoted',
      final_tool: 'propose',
      agent_key: { public_key: KEY, armed_on_vault: true, kind: 'gas_key', lanes: 4, methods: ['propose', 'decline', 'ack'] },
      limits: { max_per_payment: { base_units: '2000000', usdc: '2' }, spent_24h: { base_units: '250000', usdc: '0.25' } },
      rails: ['Near'],
    });
  });
});

describe('MCP server: same guards as the native tools', () => {
  test('pay to a blocked payee returns the preflight block and signs nothing', async () => {
    const h = await setup({ deps: { accountFacts: async (a) => lure(a) } });
    const inv = (await h.call('next_invoice')).out;
    expect(inv.invoice_id).toBe(id(1));
    expect(inv.policy).toBe(mcpPolicy('Northwind'));
    const r = await h.call('pay', money(id(1), 'e'.repeat(64)));
    expect(r.isError).toBe(true);
    expect(r.out).toMatchObject({ verdict: 'block', error: 'payment blocked by the preflight; nothing was signed', invoice_id: id(1) });
    expect(h.signed()).toEqual([]);
    expect(h.audit[0]).toMatchObject({ tool: 'pay', verdict: 'block', may_sign: false });
    // still the current invoice: a refusal is not a decision
    expect((await h.call('next_invoice')).out.invoice_id).toBe(id(1));
  });

  test('AG-02: at most three signed calls per invoice through MCP, then the invoice is closed', async () => {
    let sent = 0;
    const h = await setup({
      deps: {
        pay: async () => {
          sent++;
          throw new Error('Smart contract panicked: payment count limit reached');
        },
      },
    });
    await h.call('next_invoice');
    const outs = [];
    for (let i = 0; i < 6; i++) outs.push(await h.call('pay', money(id(1), 'acme.testnet')));
    expect(sent).toBe(MAX_SIGNS_PER_INVOICE);
    // the contract refusal comes back verbatim
    expect(outs[0].out.error).toBe('Smart contract panicked: payment count limit reached');
    expect(outs[MAX_SIGNS_PER_INVOICE].out).toMatchObject({ error: OUT_OF_SIGNS, decided: false });
    // past the budget there is no current invoice to sign for
    expect(outs[MAX_SIGNS_PER_INVOICE + 1].out.error).toBe('no current invoice; call next_invoice first');
    expect(sent).toBe(MAX_SIGNS_PER_INVOICE);
    // like an undecided native invoice: past it, and in the ack
    expect(h.session.state().acks.open?.ids).toEqual([id(1)]);
    expect((await h.call('next_invoice')).out.invoice_id).toBe(id(2));
  });

  test('parallel calls are serialized: one decision, the second finds no invoice', async () => {
    const h = await setup();
    await h.call('next_invoice');
    const [a, b] = await Promise.all([h.call('pay', money(id(1), 'acme.testnet')), h.call('decline', { invoice_id: id(1), reason: 'dup' })]);
    expect(a.out).toMatchObject({ ok: true, preflight: 'allow', decided: true });
    expect(b.out.error).toBe('no current invoice; call next_invoice first');
    expect(h.signed()).toEqual([`pay(${id(1)},acme.testnet,1370000,Near)`]);
  });

  test('Demoted: pay is refused with a pointer to propose; propose on a warn payee signs', async () => {
    const h = await setup({ mode: 'Demoted', deps: { accountFacts: async (a) => ({ ...lure(a), exists: true, first_tx_at: '2025-01-01T00:00:00.000Z' }) } });
    expect((await h.call('next_invoice')).out).toMatchObject({ mode: 'Demoted', final_tool: 'propose' });
    const paid = await h.call('pay', money(id(1), 'newvendor.testnet'));
    expect(paid.out).toMatchObject({ error: 'pay is not available in mode Demoted', hint: 'Use propose or decline in mode Demoted.' });
    expect(h.calls).toEqual([]);
    const proposed = await h.call('propose', money(id(1), 'newvendor.testnet'));
    expect(proposed.out).toMatchObject({ ok: true, preflight: 'warn', decided: true });
    expect(h.signed()).toEqual([`propose(${id(1)},newvendor.testnet,1370000,Near)`]);
  });

  test('a chain refusal after a demotion comes back verbatim', async () => {
    const msg = 'Transaction method name pay is not allowed by the access key (AccessKeyMethodNameMismatch)';
    const h = await setup({ deps: { pay: async () => Promise.reject(new Error(msg)) } });
    await h.call('next_invoice');
    expect((await h.call('pay', money(id(1), 'acme.testnet'))).out.error).toBe(msg);
  });

  test('foreign invoice ids, missing invoice and an unarmed key sign nothing', async () => {
    const h = await setup();
    expect((await h.call('decline', { invoice_id: id(1), reason: 'x' })).out.error).toBe('no current invoice; call next_invoice first');
    await h.call('next_invoice');
    expect((await h.call('decline', { invoice_id: id(9), reason: 'x' })).out.error).toBe('invoice_id must be the current invoice');
    // a schema violation is refused by the SDK before the session runs
    expect((await h.call('pay', { ...money(id(1), 'acme.testnet'), extra: 1 })).isError).toBe(true);
    h.status.mode = 'Frozen';
    expect((await h.call('decline', { invoice_id: id(1), reason: 'x' })).out).toMatchObject({ error: 'this key is not armed on the vault; nothing was signed' });
    expect(h.calls).toEqual([]);
  });

  test('unarmed or another key: next_invoice waits and never reads the inbox', async () => {
    const h = await setup({ mode: 'Unarmed' });
    expect((await h.call('next_invoice')).out).toMatchObject({ invoice: null, waiting: true, mode: 'Unarmed' });
    h.status.mode = 'Armed';
    h.status.agent_key = 'ed25519:other';
    expect((await h.call('next_invoice')).out).toMatchObject({ waiting: true, key_armed: false });
    expect(h.api.hits).toEqual([]);
  });

  test('AG-08: an inbox body over 128 KB is refused and the cursor stays', async () => {
    const h = await setup({ oversize: true });
    const r = await h.call('next_invoice');
    expect(r.isError).toBe(true);
    expect(String(r.out.error)).toContain('byte limit');
    expect(h.session.state().cursor).toBeNull();
    expect(h.calls).toEqual([]);
  });

  test('a decision advances the cursor; items decided on chain are skipped and acked', async () => {
    const h = await setup({ rows: [{ id: id(1), at: T0 }, { id: id(2), at: T0 }, { id: id(3), at: T0 }], decided: [id(2)] });
    await h.call('next_invoice');
    const d = await h.call('decline', { invoice_id: id(1), reason: 'payee change needs verification by a human' });
    expect(d.out).toMatchObject({ ok: true, decided: true, invoice_id: id(1) });
    expect((await h.call('next_invoice')).out.invoice_id).toBe(id(3));
    expect(h.session.state().acks.open?.ids).toEqual([id(1), id(2)]);
    await h.call('decline', { invoice_id: id(3), reason: 'x' });
    expect((await h.call('next_invoice')).out).toMatchObject({ invoice: null });
  });
});

describe('MCP server: release acks keep running', () => {
  test('the background walk closes a decided tick and acks it once the release is posted', async () => {
    const tick1 = [id(1), id(2)];
    const h = await setup({ rows: [...tick1.map((x) => ({ id: x, at: T0 })), { id: id(3), at: T0 + TICK }] });
    for (const x of tick1) {
      await h.call('next_invoice');
      await h.call('decline', { invoice_id: x, reason: 'x' });
    }
    await h.session.tick(); // next item is from a later tick: tick1 closes, no release yet
    expect(h.session.state().acks.pending.map((p) => p.count)).toEqual([2]);
    expect(h.acks).toEqual([]);
    const at = releaseAtNs(new Date(T0).toISOString());
    h.releases.set(at, { root: merkleRootHex(tick1), count: 2, at: '0', ack: null });
    h.setNow(NOW + TICK_SETTLE_MS);
    await h.session.tick();
    expect(h.acks).toEqual([`${at}:${merkleRootHex(tick1)}`]);
    await h.session.tick();
    expect(h.acks.length).toBe(1);
    expect(h.session.state().acks.pending).toEqual([]);
  });
});

describe('MCP server: an undecided invoice ends like MAX_STEPS in index.ts', () => {
  test('tool-call limit: the invoice is acked undecided and reported once', async () => {
    const h = await setup({ rows: [{ id: id(1), at: T0 }, { id: id(2), at: T0 }], maxCalls: 5 });
    const first = (await h.call('next_invoice')).out; // call 1
    expect(first).toMatchObject({ invoice_id: id(1), tool_calls_left: 4 });
    for (let i = 0; i < 3; i++) await h.call('check_account', { account_id: 'acme.testnet' }); // calls 2 to 4
    expect((await h.call('get_status')).out.current_invoice).toMatchObject({ invoice_id: id(1), tool_calls_left: 0 }); // call 5
    const next = (await h.call('next_invoice')).out;
    expect(next).toMatchObject({ invoice_id: id(2), skipped_previous: { invoice_id: id(1), reason: 'no decision within 5 tool calls', acked: true } });
    // index.ts acks an invoice whose steps ran out undecided; only MAX_ATTEMPTS failures stay out (AG-03)
    expect(h.session.state().acks.open?.ids).toEqual([id(1)]);
    expect(h.session.state().cursor?.afterId).toBe(id(1));
    expect((await h.call('next_invoice')).out.skipped_previous).toBeUndefined();
    // the given-up invoice can no longer be signed for
    expect((await h.call('decline', { invoice_id: id(1), reason: 'late' })).out.error).toBe('invoice_id must be the current invoice');
    expect(h.signed()).toEqual([]);
  });

  test('timeout: an invoice served and never acted on is given up without an ack (NF-01)', async () => {
    const h = await setup({ rows: [{ id: id(1), at: T0 }, { id: id(2), at: T0 }, { id: id(3), at: T0 }], timeoutMs: 60_000 });
    expect((await h.call('next_invoice')).out).toMatchObject({ invoice_id: id(1), decide_by: new Date(NOW + 60_000).toISOString() });
    h.setNow(NOW + 59_999);
    await h.session.tick();
    expect(h.session.state().cursor).toBeNull();
    h.setNow(NOW + 60_000);
    await h.session.tick(); // the background walk gives up a silent client
    expect(h.session.state().cursor?.afterId).toBe(id(1));
    expect(h.session.state().acks.open).toBeNull();
    expect((await h.call('next_invoice')).out).toMatchObject({ invoice_id: id(2), skipped_previous: { invoice_id: id(1), reason: 'no decision within 60 s', acked: false } });
    // worked on, then left: acked like MAX_STEPS; the decision call itself finds the deadline passed
    await h.call('check_account', { account_id: 'acme.testnet' });
    h.setNow(NOW + 120_001);
    const late = await h.call('pay', money(id(2), 'acme.testnet'));
    expect(late.out.error).toBe('no current invoice; call next_invoice first');
    expect(h.signed()).toEqual([]);
    expect(h.session.state().acks.open?.ids).toEqual([id(2)]);
    expect((await h.call('next_invoice')).out).toMatchObject({ invoice_id: id(3), skipped_previous: { invoice_id: id(2), acked: true } });
  });

  test('tool-call limit reached by re-reading only: no evidence the model read it, no ack (NF-01)', async () => {
    const h = await setup({ maxCalls: 4 });
    await h.call('next_invoice');
    await h.call('next_invoice');
    await h.call('get_status');
    await h.call('next_invoice'); // call 4
    const r = (await h.call('next_invoice')).out;
    expect(r).toMatchObject({ invoice_id: id(2), skipped_previous: { invoice_id: id(1), reason: 'no decision within 4 tool calls', acked: false } });
    expect(h.session.state().acks.open).toBeNull();
  });

  test('an item whose result exceeds MCP_MAX_RESULT_BYTES is never shown and never acked (NF-01)', async () => {
    const h = await setup({ rows: [{ id: id(1), at: T0 }, { id: id(2), at: T0 }], padBytes: { [id(1)]: 70_000 } });
    const r = await h.call('next_invoice');
    expect(r.isError).toBe(false);
    expect(r.out).toMatchObject({ invoice_id: id(2), skipped_previous: { invoice_id: id(1), reason: TOO_LARGE, acked: false } });
    expect(JSON.stringify(r.out)).not.toContain('x'.repeat(100));
    expect(h.session.state().cursor?.afterId).toBe(id(1));
    expect(h.session.state().acks.open).toBeNull();
    // deciding the next one acks only that one
    await h.call('decline', { invoice_id: id(2), reason: 'x' });
    expect(h.session.state().acks.open?.ids).toEqual([id(2)]);
  });

  test('the size cap is configurable: a larger cap serves the same item', async () => {
    const h = await setup({ padBytes: { [id(1)]: 70_000 }, maxResultBytes: 100_000 });
    expect((await h.call('next_invoice')).out.invoice_id).toBe(id(1));
  });
});

describe('concurrent native agent guard', () => {
  test('refuses while the native state file is fresh, unless allowed; old or missing files pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-guard-'));
    const f = join(dir, 'state.json');
    writeFileSync(f, '{}');
    const now = Date.now();
    expect(() => assertNoNativeAgent(f, now, false)).toThrow('native agent looks active');
    expect(() => assertNoNativeAgent(f, now, true)).not.toThrow();
    const old = (now - CONCURRENT_WINDOW_MS - 1000) / 1000;
    utimesSync(f, old, old);
    expect(() => assertNoNativeAgent(f, now, false)).not.toThrow();
    expect(() => assertNoNativeAgent(join(dir, 'missing.json'), now, false)).not.toThrow();
  });
});

describe('MCP_PREFLIGHT=advisory: the bare model decides', () => {
  const unapprovedOld = (a: string): AccountFacts => ({ ...lure(a), exists: true, first_tx_at: '2025-01-01T00:00:00.000Z' });

  test('enforce is the default: verdict stops the payment, get_status says so', async () => {
    const h = await setup({ deps: { accountFacts: async (a) => lure(a) } });
    expect((await h.call('get_status')).out.preflight_mode).toBe('enforce');
    const pay = (await h.client.listTools()).tools.find((t) => t.name === 'pay')!;
    expect(pay.description).not.toContain('ADVISORY');
    await h.call('next_invoice');
    expect((await h.call('pay', money(id(1), 'e'.repeat(64)))).out).toMatchObject({ verdict: 'block', error: 'payment blocked by the preflight; nothing was signed' });
    expect(h.signed()).toEqual([]);
  });

  test('a block verdict is reported and the payment is signed anyway', async () => {
    const h = await setup({ preflight: 'advisory', deps: { accountFacts: async (a) => lure(a) } });
    expect((await h.call('get_status')).out.preflight_mode).toBe('advisory');
    const pay = (await h.client.listTools()).tools.find((t) => t.name === 'pay')!;
    expect(pay.description).toContain('ADVISORY');
    await h.call('next_invoice');
    const r = await h.call('pay', money(id(1), 'e'.repeat(64)));
    expect(r.isError).toBe(false);
    expect(r.out).toMatchObject({ ok: true, decided: true, preflight: 'block', preflight_mode: 'advisory', overridden: true });
    expect((r.out.preflight_reasons as { code: string }[]).map((x) => x.code)).toEqual(['payee_not_approved', 'account_not_found']);
    expect(h.signed()).toEqual([`pay(${id(1)},${'e'.repeat(64)},1370000,Near)`]);
    // logged on every override
    expect(h.audit.map((a) => a.msg)).toEqual(['payment preflight', 'advisory preflight: signing despite block']);
    expect(h.audit[0]).toMatchObject({ verdict: 'block', may_sign: true, preflight_mode: 'advisory' });
  });

  test('warn signs too; allow is not an override; Demoted proposes despite block', async () => {
    const warn = await setup({ preflight: 'advisory', deps: { accountFacts: async (a) => unapprovedOld(a) } });
    await warn.call('next_invoice');
    expect((await warn.call('pay', money(id(1), 'newvendor.testnet'))).out).toMatchObject({ preflight: 'warn', overridden: true, decided: true });
    const ok = await setup({ preflight: 'advisory' });
    await ok.call('next_invoice');
    expect((await ok.call('pay', money(id(1), 'acme.testnet'))).out).toMatchObject({ preflight: 'allow', overridden: false, preflight_reasons: [] });
    expect(ok.audit.map((a) => a.msg)).toEqual(['payment preflight']);
    const demoted = await setup({ preflight: 'advisory', mode: 'Demoted', deps: { accountFacts: async (a) => lure(a) } });
    await demoted.call('next_invoice');
    expect((await demoted.call('propose', money(id(1), 'e'.repeat(64)))).out).toMatchObject({ preflight: 'block', overridden: true });
    expect(demoted.signed()).toEqual([`propose(${id(1)},${'e'.repeat(64)},1370000,Near)`]);
    // mode gating is not advisory
    expect((await demoted.call('next_invoice')).out.invoice_id).toBe(id(2));
    expect((await demoted.call('pay', money(id(2), 'acme.testnet'))).out.error).toBe('pay is not available in mode Demoted');
  });

  test('still refused in advisory: reserved accounts, a failed preflight read, bad input, a foreign invoice', async () => {
    const h = await setup({ preflight: 'advisory' });
    await h.call('next_invoice');
    expect((await h.call('pay', money(id(1), 'usdc.testnet'))).out).toMatchObject({ verdict: 'block', error: 'payment blocked by the preflight; nothing was signed' });
    expect((await h.call('pay', money(id(1), 'Not An Account'))).out.error).toBe('payee is not a valid NEAR account id');
    expect((await h.call('pay', money(id(1), 'acme.testnet', '1e9'))).out.error).toContain('decimal string');
    expect((await h.call('pay', money(id(2), 'acme.testnet'))).out.error).toBe('invoice_id must be the current invoice');
    const down = await setup({ preflight: 'advisory', deps: { accountFacts: async () => Promise.reject(new Error('rpc timeout')) } });
    await down.call('next_invoice');
    expect((await down.call('pay', money(id(1), 'acme.testnet'))).out).toMatchObject({ verdict: 'block' });
    expect([...h.signed(), ...down.signed()]).toEqual([]);
  });

  test('the contract and the sign cap still bound an override', async () => {
    let sent = 0;
    const refusal = 'Smart contract panicked: payee is not approved';
    const h = await setup({
      preflight: 'advisory',
      deps: {
        accountFacts: async (a) => lure(a),
        pay: async () => {
          sent++;
          throw new Error(refusal);
        },
      },
    });
    await h.call('next_invoice');
    const outs = [];
    for (let i = 0; i < 5; i++) outs.push((await h.call('pay', money(id(1), 'e'.repeat(64)))).out);
    expect(sent).toBe(MAX_SIGNS_PER_INVOICE);
    expect(outs[0].error).toBe(refusal); // listed_only on chain refuses it verbatim
    expect(outs[MAX_SIGNS_PER_INVOICE]).toMatchObject({ error: OUT_OF_SIGNS });
  });

  test('MCP_PREFLIGHT accepts enforce or advisory only', () => {
    expect(preflightMode(undefined)).toBe('enforce');
    expect(preflightMode('')).toBe('enforce');
    expect(preflightMode('advisory')).toBe('advisory');
    for (const bad of ['Advisory', 'off', 'none']) expect(() => preflightMode(bad)).toThrow('MCP_PREFLIGHT must be enforce or advisory');
  });
});

describe('state lock and paths (NF-05)', () => {
  test('one server per state file; a dead holder is stale; release removes only its own lock', () => {
    const state = join(mkdtempSync(join(tmpdir(), 'mcp-lock-')), 'state.json');
    const release = acquireStateLock(state);
    expect(() => acquireStateLock(state, process.pid + 1)).toThrow('another MCP server uses this state');
    release();
    const again = acquireStateLock(state);
    again();
    let dead = 4_000_000;
    while ((() => { try { process.kill(dead, 0); return true; } catch { return false; } })()) dead++;
    writeFileSync(`${state}.lock`, String(dead));
    const fresh = acquireStateLock(state);
    expect(readFileSync(`${state}.lock`, 'utf8')).toBe(String(process.pid));
    fresh();
    expect(existsSync(`${state}.lock`)).toBe(false);
  });

  test('relative state paths mean agent/, as for the native agent, whatever the client cwd', () => {
    expect(agentPath('./state.json')).toBe(join(AGENT_DIR, 'state.json'));
    expect(agentPath('/var/x.json')).toBe('/var/x.json');
    expect(existsSync(join(AGENT_DIR, 'index.ts'))).toBe(true);
  });
});

describe('stdout guard (NF-09)', () => {
  test('only the transport writer reaches stdout', () => {
    const code = `const { reserveStdout } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'mcp', 'stdout.ts'))});
      const wire = reserveStdout();
      process.stdout.write('X'); console.log('L'); console.info('I'); console.debug('D'); console.table([1]); console.dir({ d: 1 });
      await new Promise((r) => wire.write('{"jsonrpc":"2.0"}\\n', r));`;
    const r = Bun.spawnSync([process.execPath, '-e', code], { cwd: mkdtempSync(join(tmpdir(), 'mcp-out-')), env: { PATH: process.env.PATH ?? '' } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe('{"jsonrpc":"2.0"}\n');
    for (const t of ['X', 'L', 'I', 'D']) expect(r.stderr.toString()).toContain(t);
  });
});

describe('MCP entry', () => {
  test('a config error exits non-zero and writes nothing to stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-entry-')); // no .env here
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'mcp.ts')], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, stdin: 'ignore' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString()).toBe('');
    expect(r.stderr.toString()).toContain('Missing env AGENT_VAULT_ID');
  });

  test('refuses to start next to a native agent that just wrote its state, and out-of-range limits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-entry-'));
    writeFileSync(join(dir, 'native.json'), '{}');
    const base = { PATH: process.env.PATH ?? '', AGENT_VAULT_ID: 'v.testnet', AGENT_PRIVATE_KEY: 'ed25519:x', INBOX_URL: 'https://inbox.example.com', INBOX_TOKEN: 't', AGENT_STATE_FILE: join(dir, 'native.json'), MCP_STATE_PATH: join(dir, 'mcp.json') };
    const spawn = (env: Record<string, string>) => Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'mcp.ts')], { cwd: dir, env: { ...base, ...env }, stdin: 'ignore' });
    const r = spawn({});
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString()).toBe('');
    expect(r.stderr.toString()).toContain('MCP_ALLOW_CONCURRENT=1');
    for (const [k, v] of [['MCP_MAX_RESULT_BYTES', '100'], ['MCP_DECISION_TIMEOUT_S', '10'], ['MCP_DECISION_TIMEOUT_S', 'soon'], ['MCP_MAX_TOOL_CALLS_PER_INVOICE', '1'], ['MCP_MAX_TOOL_CALLS_PER_INVOICE', '2.5']]) {
      const bad = spawn({ [k]: v, MCP_ALLOW_CONCURRENT: '1' });
      expect(bad.exitCode).not.toBe(0);
      expect(bad.stderr.toString()).toContain(`${k} must be an integer`);
    }
  });

  test('MCP_STATE_PATH may not share the native agent state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-entry-'));
    const env = { PATH: process.env.PATH ?? '', AGENT_VAULT_ID: 'v.testnet', AGENT_PRIVATE_KEY: 'ed25519:x', INBOX_URL: 'https://inbox.example.com', INBOX_TOKEN: 't', AGENT_STATE_FILE: './s.json', MCP_STATE_PATH: 's.json' };
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'mcp.ts')], { cwd: dir, env, stdin: 'ignore' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString()).toBe('');
    expect(r.stderr.toString()).toContain('MCP_STATE_PATH must differ from AGENT_STATE_FILE');
  });
});
