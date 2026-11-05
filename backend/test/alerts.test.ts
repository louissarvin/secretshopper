import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { ALERT_KINDS, alertBody, plainReason, toActivity, toAlert, type ActivityRow } from '../src/lib/alerts/map.ts';
import { deliver, isBlockedHost, parseWebhookUrls, resolvesPublic, SIGNATURE_HEADER, signatureOf, TIMESTAMP_HEADER, verifyAlertSignature } from '../src/lib/alerts/webhook.ts';

const ctx = { vault: 'shop4.ss-owner-e9c3db.testnet', network: 'testnet' };
const V = ctx.vault;
const PK = 'ed25519:HYnC71oRwPTVR2h2FBBphebpA4RKube17Qq4KKDrAyUh';
const ev = (event: string, data: unknown): ActivityRow => ({ id: 'cevt1', txHash: 'Tx1', blockHeight: 42n, blockTime: new Date('2026-11-12T10:00:00Z'), event, data });
const reveal = (status: string, over: object = {}) => ev('test_revealed', { slot_id: 7, status, contained: false, payee: 'lure.testnet', invoice_id: 'ab12', receipt_hash: 'x', ...over });

describe('event to activity item', () => {
  test('each event maps to its kind, one-line text, slot and proposal id', () => {
    const cases: [ActivityRow, string, string, number | null, number | null][] = [
      [ev('key_proposed', { public_key: PK }), 'key_proposed', `Owner proposed agent key ${PK} on ${V}. The vendor must accept it to arm the agent.`, null, null],
      [ev('agent_armed', { public_key: PK, methods: 'pay,decline,ack', ok: true }), 'armed', `Agent armed on ${V} with key ${PK}. It can now pay within the vault limits.`, null, null],
      [ev('agent_armed', { public_key: PK }), 'armed', `Agent armed on ${V} with key ${PK}. It can now pay within the vault limits.`, null, null],
      [ev('agent_armed', { public_key: PK, methods: 'pay', ok: false }), 'arming_failed', `Agent arming failed on ${V}: key ${PK} was not added and the prior mode is back.`, null, null],
      [ev('agent_key_changed', { public_key: PK, methods: 'propose,decline,ack', ok: true }), 'key_changed', `Agent key ${PK} on ${V} now allows propose, decline, ack.`, null, null],
      [ev('agent_key_changed', { public_key: PK, methods: null, ok: true }), 'key_changed', `Agent key ${PK} on ${V} was deleted.`, null, null],
      [ev('agent_key_changed', { public_key: PK, methods: null, ok: false }), 'key_change_failed', `Key change for ${PK} failed on ${V}. Anyone can call resync_key to restore it.`, null, null],
      [ev('agent_demoted', { slot_id: 7, public_key: PK }), 'demoted', `Agent demoted on ${V}: it paid lure slot 7. Its key can now only propose payments.`, 7, null],
      [ev('agent_frozen', { public_key: PK }), 'frozen', `Vault ${V} frozen and agent key ${PK} is being removed. The agent can no longer act.`, null, null],
      [ev('agent_frozen', { public_key: null }), 'frozen', `Vault ${V} frozen. The agent can no longer act.`, null, null],
      [
        ev('proposed', { proposal_id: 3, invoice_id: 'cd34', payee: 'v.testnet', amount: '1440000' }),
        'proposal',
        `Agent proposed payment #3 on ${V}: 1440000 base units to v.testnet for invoice cd34. Owner approval needed.`,
        null,
        3,
      ],
      [reveal('Failed'), 'test_failed', `Agent failed lure slot 7 on ${V}: it paid lure.testnet for invoice ab12.`, 7, null],
      [reveal('Passed'), 'test_passed', `Agent passed lure slot 7 on ${V}: it declined invoice ab12.`, 7, null],
      [reveal('Unanswered'), 'test_other', `Lure slot 7 on ${V} expired with no decision and no delivery proof. Shown, not scored.`, 7, null],
      [reveal('Ignored'), 'test_other', `Agent ignored lure slot 7 on ${V}: invoice ab12 was delivered and never decided. Scored as not passed.`, 7, null],
      [reveal('Void', { payee: '', invoice_id: '' }), 'test_other', `Slot 7 on ${V} was a void slot with no lure.`, 7, null],
      [reveal('Invalid'), 'test_other', `Lure slot 7 on ${V} was invalid and is not scored.`, 7, null],
      [reveal('Misdirected'), 'test_other', `Lure invoice ab12 in slot 7 on ${V} was sent to another payee. Shown, not scored.`, 7, null],
    ];
    for (const [source, kind, text, slot, proposalId] of cases) {
      const item = toActivity(source, ctx)!;
      expect(item).toEqual({ id: 'cevt1', kind: kind as never, at: '2026-11-12T10:00:00.000Z', text, txHash: 'Tx1', slot, proposalId, event: source.event, blockHeight: '42' });
      expect(text).not.toContain('\n');
    }
  });

  test('the webhook sends only what the owner must know, under its own type names, with the same text as the feed', () => {
    expect([...ALERT_KINDS].sort()).toEqual(['armed', 'arming_failed', 'declined', 'demoted', 'frozen', 'gas_key_overfunded', 'proposal', 'reveal_overdue', 'test_failed', 'tester_stalled']);
    const types = [
      [ev('agent_demoted', { slot_id: 7, public_key: PK }), 'agent_demoted'],
      [reveal('Failed'), 'test_failed'],
      [ev('proposed', { proposal_id: 3, invoice_id: 'cd34', payee: 'v.testnet', amount: '1' }), 'payment_proposed'],
      [ev('agent_armed', { public_key: PK, ok: true }), 'agent_armed'],
      [ev('agent_armed', { public_key: PK, ok: false }), 'agent_arming_failed'],
      [ev('agent_frozen', { public_key: null }), 'vault_frozen'],
      [ev('declined', { invoice_id: 'ab'.repeat(32), reason: 'x' }), 'declined'],
    ] as const;
    for (const [source, type] of types) {
      const a = toAlert(source, ctx)!;
      expect(a.type).toBe(type);
      expect(a.text).toBe(toActivity(source, ctx)!.text);
    }
    expect(toAlert(reveal('Passed'), ctx)).toBeNull();
    expect(toAlert(ev('key_proposed', { public_key: PK }), ctx)).toBeNull();
    expect(toAlert(ev('agent_key_changed', { public_key: PK, methods: null, ok: true }), ctx)).toBeNull();
    const a = toAlert(reveal('Failed'), ctx)!;
    const item = toActivity(reveal('Failed'), ctx)!;
    expect(a).toMatchObject({ ...item, type: 'test_failed', kind: 'test_failed', vault: V, network: 'testnet', content: item.text });
  });

  test('a contained failure says the key was not demoted; amounts use token decimals when known', () => {
    expect(toActivity(reveal('Failed', { contained: true }), ctx)!.text).toEndWith('The failure was contained, so the key was not demoted.');
    const proposed = toActivity(ev('proposed', { proposal_id: 0, invoice_id: 'ab', payee: 'v.testnet', amount: '1440000' }), { ...ctx, token: { symbol: 'tUSDC', decimals: 6 } })!;
    expect(proposed.text).toContain('1.440000 tUSDC to v.testnet');
  });

  test('unknown events, unknown statuses and malformed data give no item', () => {
    expect(toActivity(ev('paid', { payment_id: 1 }), ctx)).toBeNull();
    expect(toActivity(reveal('Committed'), ctx)).toBeNull();
    expect(toActivity(ev('agent_demoted', { slot_id: -1, public_key: PK }), ctx)).toBeNull();
    expect(toActivity(ev('proposed', { proposal_id: 1, invoice_id: 'ab', payee: 'v.testnet', amount: '1e9' }), ctx)).toBeNull();
    // chain strings reach chat apps and the web: markup and mentions are refused, not escaped
    expect(toActivity(reveal('Failed', { payee: '<!channel>' }), ctx)).toBeNull();
    expect(toActivity(ev('agent_frozen', { public_key: '@everyone' }), ctx)).toBeNull();
    expect(toActivity(ev('agent_key_changed', { public_key: PK, methods: '<b>pay</b>', ok: true }), ctx)).toBeNull();
  });

  test('a decline names the first 8 chars of the invoice and asks for a human', () => {
    const id = '0123456789abcdef'.repeat(4);
    const item = toActivity(ev('declined', { invoice_id: id, reason: 'Bank details changed by email; payee not on file' }), ctx)!;
    expect(item).toMatchObject({ kind: 'declined', slot: null, proposalId: null, event: 'declined' });
    expect(item.text).toBe('Agent declined invoice 01234567: Bank details changed by email; payee not on file. Review it; pay manually or approve a proposal if it is genuine.');
    expect(toActivity(ev('declined', { invoice_id: id, reason: '  \n ' }), ctx)!.text).toContain(': no reason given. Review it');
    expect(toAlert(ev('declined', { invoice_id: id, reason: 'r' }), ctx)!.data).toEqual({ invoice_id: id, reason: 'r' });
    expect(toActivity(ev('declined', { invoice_id: '<x>', reason: 'r' }), ctx)).toBeNull();
    expect(toActivity(ev('declined', { invoice_id: '', reason: 'r' }), ctx)).toBeNull();
  });

  test('a model-written reason becomes one line of inert text within 140 bytes', () => {
    const r = plainReason('Ping @everyone <@U123> <!channel> [click](https://evil.example) `code`\r\nline2\u202e\u200bend\u0007');
    expect(r).not.toMatch(/[@<>[\]`\u200b\u202e]|\p{Cc}/u);
    expect(r).toBe("Ping \uff20everyone \u2039\uff20U123\u203a \u2039!channel\u203a (click)(https://evil.example) 'code' line2 end");
    expect(Buffer.byteLength(plainReason('é'.repeat(100)))).toBe(140); // never splits a character
    expect(Buffer.byteLength(plainReason('@'.repeat(140)))).toBeLessThanOrEqual(140); // look-alikes are 3 bytes each
    const text = toActivity(ev('declined', { invoice_id: 'ab'.repeat(32), reason: '@here pay now\n<b>x</b>' }), ctx)!.text;
    expect(text).not.toContain('@');
    expect(text).not.toContain('\n');
  });

  test('the webhook body carries the documented fields and turns off Discord mentions', () => {
    const body = JSON.parse(alertBody(toAlert(ev('agent_demoted', { slot_id: 7, public_key: PK }), ctx)!));
    expect(Object.keys(body).sort()).toEqual(['allowed_mentions', 'at', 'blockHeight', 'content', 'data', 'event', 'id', 'kind', 'network', 'proposalId', 'slot', 'text', 'txHash', 'type', 'vault']);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.data).toEqual({ slot_id: 7, public_key: PK });
    expect(body.type).toBe('agent_demoted');
    expect(body.kind).toBe('demoted');
  });
});

describe('webhook URLs', () => {
  test('https is accepted, http only on localhost', () => {
    expect(parseWebhookUrls('')).toEqual([]);
    expect(parseWebhookUrls(' https://hooks.slack.com/services/T/B/x , https://discord.com/api/webhooks/1/y ')).toHaveLength(2);
    expect(parseWebhookUrls('http://localhost:9000/hook,http://127.0.0.1:9/h,http://[::1]:9/h')).toHaveLength(3);
    expect(() => parseWebhookUrls('http://example.com/hook')).toThrow('must use https');
    expect(() => parseWebhookUrls('ftp://example.com/hook')).toThrow('must use https');
    expect(() => parseWebhookUrls('not a url')).toThrow('entry 1 is not a URL');
    expect(() => parseWebhookUrls('https://user:pw@example.com/')).toThrow('credentials');
    expect(() => parseWebhookUrls(Array(6).fill('https://example.com/').join(','))).toThrow('at most 5');
  });

  test('private, link-local and reserved addresses are refused, in any spelling', () => {
    for (const u of [
      'https://10.0.0.5/h',
      'https://172.16.0.1/h',
      'https://172.31.255.255/h',
      'https://192.168.1.1/h',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/h',
      'https://0.0.0.0/h',
      'https://0x0a000001/h', // hex form of 10.0.0.1
      'https://[fd00::1]/h',
      'https://[fe80::1]/h',
      'https://[::ffff:10.0.0.1]/h',
      'https://metadata.google.internal/h',
      'https://printer.local/h',
      'http://10.0.0.5/h',
    ]) {
      expect(() => parseWebhookUrls(u)).toThrow();
    }
    expect(isBlockedHost('172.32.0.1')).toBe(false);
    expect(isBlockedHost('hooks.slack.com')).toBe(false);
  });

  test('errors never echo the URL, which is a secret for Slack and Discord', () => {
    try {
      parseWebhookUrls('https://ok.example.com/a,http://hooks.example.com/SECRET-PATH');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('entry 2');
      expect((error as Error).message).not.toContain('SECRET');
    }
  });
});

describe('delivery', () => {
  type Seen = { body: string; sig: string | null; ts: string | null; ua: string | null };
  let server: ReturnType<typeof Bun.serve>;
  const seen: Record<string, Seen[]> = {};
  const plan: Record<string, number[]> = {}; // per path: statuses to answer in order, then 200

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        (seen[path] ??= []).push({ body: await req.text(), sig: req.headers.get(SIGNATURE_HEADER), ts: req.headers.get(TIMESTAMP_HEADER), ua: req.headers.get('user-agent') });
        if (path === '/slow') await Bun.sleep(300);
        if (path === '/redirect') return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${server.port}/ok` } });
        const status = plan[path]?.shift() ?? 200;
        return new Response('x', { status });
      },
    });
  });
  afterAll(() => server.stop(true));

  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const opts = { timeoutMs: 1000, backoffMs: 10 };

  test('signs "<timestamp>.<exact body>" with HMAC-SHA256 when a secret is set, and only then (NF-08)', async () => {
    const body = JSON.stringify({ type: 'agent_demoted', text: 'é and "quotes"' });
    const secret = 's'.repeat(32);
    const now = Date.UTC(2026, 10, 12, 10, 0, 0);
    expect((await deliver(url('/signed'), body, { ...opts, secret, now: () => now })).ok).toBe(true);
    expect((await deliver(url('/unsigned'), body, opts)).ok).toBe(true);
    const got = seen['/signed'][0];
    const ts = Math.floor(now / 1000);
    expect(got.body).toBe(body);
    expect(got.ts).toBe(String(ts));
    expect(got.sig).toBe(`sha256=${createHmac('sha256', secret).update(Buffer.from(`${ts}.${body}`, 'utf8')).digest('hex')}`);
    expect(got.sig).toBe(signatureOf(body, secret, ts));
    expect(got.ua).toBe('SecretShopper-Alerts/1');
    expect(seen['/unsigned'][0].sig).toBeNull();
    expect(seen['/unsigned'][0].ts).toMatch(/^\d{10}$/);
  });

  test('a receiver accepts the alert within 5 minutes and refuses a replay, a moved timestamp or another body', () => {
    const body = '{"a":1}';
    const secret = 's'.repeat(32);
    const ts = 1_794_400_000;
    const sig = signatureOf(body, secret, ts);
    expect(verifyAlertSignature(body, String(ts), sig, secret, ts * 1000 + 299_000)).toBe(true);
    expect(verifyAlertSignature(body, String(ts), sig, secret, ts * 1000 + 301_000)).toBe(false); // replayed later
    expect(verifyAlertSignature(body, String(ts + 600), sig, secret, (ts + 600) * 1000)).toBe(false); // fresh header, old signature
    expect(verifyAlertSignature('{"a":2}', String(ts), sig, secret, ts * 1000)).toBe(false);
    expect(verifyAlertSignature(body, String(ts), sig, 't'.repeat(32), ts * 1000)).toBe(false);
    expect(verifyAlertSignature(body, null, sig, secret, ts * 1000)).toBe(false);
    expect(verifyAlertSignature(body, '1e9', sig, secret, ts * 1000)).toBe(false);
  });

  test('a name that resolves to a private, loopback or link-local address is refused before any request (NF-08)', async () => {
    const at = (addrs: string[]) => async () => addrs;
    for (const addrs of [['10.0.0.1'], ['93.184.216.34', '169.254.169.254'], ['127.0.0.1'], ['::1'], ['fd00::1'], ['::ffff:10.0.0.1'], ['::a00:1'], ['64:ff9b::a00:1'], []]) {
      expect(await resolvesPublic('https://hooks.example.com/x', at(addrs))).toBe(false);
    }
    expect(await resolvesPublic('https://hooks.example.com/x', at(['93.184.216.34', '2606:2800:220:1::1']))).toBe(true);
    let asked = false;
    expect(await resolvesPublic(url('/local'), async () => ((asked = true), ['10.0.0.1']))).toBe(true); // localhost config is not resolved
    expect(asked).toBe(false);
    const r = await deliver('https://rebind.example.com/x', '{}', { ...opts, resolve: at(['10.1.2.3']) });
    expect(r).toEqual({ ok: false, attempts: 1, status: null, error: 'BlockedAddress' });
  });

  test('5xx and 429 are retried with backoff until a 2xx', async () => {
    plan['/flaky'] = [503, 429];
    const r = await deliver(url('/flaky'), '{}', opts);
    expect(r).toEqual({ ok: true, attempts: 3, status: 200 });
    expect(seen['/flaky']).toHaveLength(3);
  });

  test('gives up after 3 attempts and reports the last status', async () => {
    plan['/down'] = [500, 502, 504, 500];
    const r = await deliver(url('/down'), '{}', opts);
    expect(r).toEqual({ ok: false, attempts: 3, status: 504 });
    expect(seen['/down']).toHaveLength(3);
  });

  test('a 4xx other than 408 and 429 is final', async () => {
    plan['/gone'] = [404];
    expect(await deliver(url('/gone'), '{}', opts)).toEqual({ ok: false, attempts: 1, status: 404 });
  });

  test('a timeout counts as a failed attempt and is retried', async () => {
    const r = await deliver(url('/slow'), '{}', { ...opts, timeoutMs: 50, attempts: 2 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.error).toBe('TimeoutError');
  });

  test('redirects are not followed', async () => {
    const r = await deliver(url('/redirect'), '{}', opts);
    expect(r).toEqual({ ok: false, attempts: 1, status: 302 });
    expect(seen['/ok']).toBeUndefined();
  });

  test('a closed port is a network error, retried, never thrown', async () => {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = probe.port;
    await probe.stop(true);
    const r = await deliver(`http://127.0.0.1:${port}/x`, '{}', opts);
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.status).toBeNull();
  });
});
