import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  buildQuoteRequest,
  createBudget,
  type OneClickToken,
  dryQuote,
  formatUnits,
  listTokens,
  ONECLICK_URL,
  parseUnits,
  QUOTE_DEADLINE_MS,
  QuoteInputError,
  QuoteRejectedError,
  QuoteUpstreamError,
  USDC_NEAR_ASSET,
} from '../src/lib/intents/quote.ts';

// Real 1Click responses captured on 2026-11-10 (GET /v0/tokens subset, POST /v0/quote with dry: true).
const TOKENS = (await Bun.file(resolve(import.meta.dir, 'fixtures/oneclick-tokens.json')).json()) as unknown[];
const QUOTE = (await Bun.file(resolve(import.meta.dir, 'fixtures/oneclick-quote-dry.json')).json()) as {
  quoteRequest: Record<string, unknown>;
  quote: Record<string, unknown>;
};

const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const RECIPIENT = '0x2527D02599Ba641c19FEa793cD0F167589a0f10D'; // example address in request-a-swap-quote.md
const PAYEE = '0'.repeat(64); // implicit account
const NOW = new Date('2026-11-10T04:55:00.000Z');
const INPUT = { payee: PAYEE, destinationAsset: BASE_USDC, amount: '25000000', recipient: RECIPIENT };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Injected fetch: records every request and answers from the captured responses. */
const recorder = (quote: { status: number; body: unknown } = { status: 201, body: QUOTE }) => {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith('/v0/tokens')) return Response.json(TOKENS);
    if (u.endsWith('/v0/quote')) return Response.json(quote.body, { status: quote.status });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: f };
};

describe('1Click dry quote: request shape', () => {
  test('GET /v0/tokens, then POST /v0/quote with the documented body and no auth header', async () => {
    const r = recorder();
    await dryQuote(INPUT, { fetch: r.fetch, now: () => NOW });
    expect(r.calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${ONECLICK_URL}/v0/tokens`],
      ['POST', `${ONECLICK_URL}/v0/quote`],
    ]);
    expect(r.calls[1].headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' });
    expect(r.calls[1].body).toEqual({
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: USDC_NEAR_ASSET,
      depositType: 'INTENTS',
      destinationAsset: BASE_USDC,
      amount: '25000000',
      recipient: RECIPIENT,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: PAYEE,
      refundType: 'INTENTS',
      deadline: new Date(NOW.getTime() + QUOTE_DEADLINE_MS).toISOString(),
    });
  });

  test('a configured JWT goes in X-API-Key only', async () => {
    const r = recorder();
    const q = await dryQuote({ ...INPUT, slippageBps: 50 }, { fetch: r.fetch, jwt: 'partner.jwt.value', now: () => NOW });
    expect(r.calls[1].headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': 'partner.jwt.value' });
    expect((r.calls[1].body as { slippageTolerance: number }).slippageTolerance).toBe(50);
    expect(q.authenticated).toBe(true);
  });

  test('the payee-facing fields come from the response, with the raw response kept', async () => {
    const q = await dryQuote(INPUT, { fetch: recorder().fetch, now: () => NOW });
    expect(q.dry).toBe(true);
    expect(q.authenticated).toBe(false);
    expect(q.feeNote).toContain('0.25% (25 bps)');
    expect(q.origin).toEqual({ assetId: USDC_NEAR_ASSET, symbol: 'USDC', blockchain: 'near', decimals: 6 });
    expect(q.destination.blockchain).toBe('base');
    expect(q.amountOut).toBe(QUOTE.quote.amountOut as string);
    expect(q.minAmountOutFormatted).toBe(formatUnits(QUOTE.quote.minAmountOut as string, 6));
    expect(q.fees.withdrawFee).toBe('2400');
    expect(q.fees.withdrawFeeFormatted).toBe('0.0024');
    expect(q.fees.appFees).toEqual(QUOTE.quoteRequest.appFees as { recipient: string; fee: number }[]);
    expect(q.timeEstimateSeconds).toBe(QUOTE.quote.timeEstimate as number);
    expect(q.validUntil).toBe(new Date(NOW.getTime() + QUOTE_DEADLINE_MS).toISOString());
    expect(q.raw).toEqual(QUOTE);
  });
});

describe('1Click dry quote: input validation', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['uppercase payee', { payee: 'Bob.near' }],
    ['decimal amount', { amount: '25.5' }],
    ['zero amount', { amount: '0' }],
    ['leading zero', { amount: '025' }],
    ['negative amount', { amount: '-1' }],
    ['empty recipient', { recipient: '' }],
    ['recipient with a space', { recipient: '0xabc def' }],
    ['recipient too long', { recipient: 'a'.repeat(257) }],
    ['slippage above 10%', { slippageBps: 5000 }],
    ['fractional slippage', { slippageBps: 1.5 }],
    ['empty asset', { destinationAsset: '' }],
    ['unknown field', { extra: 1 }],
  ];
  for (const [name, patch] of bad) {
    test(`${name} is refused before any request`, async () => {
      const r = recorder();
      await expect(dryQuote({ ...INPUT, ...patch } as typeof INPUT, { fetch: r.fetch })).rejects.toBeInstanceOf(QuoteInputError);
      expect(r.calls).toHaveLength(0);
    });
  }

  test('a destination asset outside the token list is refused before the quote', async () => {
    const r = recorder();
    await expect(dryQuote({ ...INPUT, destinationAsset: 'nep141:not-a-listed.token.near' }, { fetch: r.fetch })).rejects.toBeInstanceOf(QuoteInputError);
    expect(r.calls.map((c) => c.url)).toEqual([`${ONECLICK_URL}/v0/tokens`]);
  });

  test('a NEAR destination needs a NEAR account id as recipient', async () => {
    const r = recorder();
    await expect(dryQuote({ ...INPUT, destinationAsset: 'nep141:wrap.near' }, { fetch: r.fetch })).rejects.toBeInstanceOf(QuoteInputError);
    expect(r.calls).toHaveLength(1);
  });

  test('plain http to a remote 1Click URL is refused', async () => {
    await expect(dryQuote(INPUT, { fetch: recorder().fetch, baseUrl: 'http://1click.example.com' })).rejects.toThrow('must use https');
  });

  test('units convert exactly', () => {
    expect(parseUnits('25.5', 6)).toBe('25500000');
    expect(parseUnits('0.000001', 6)).toBe('1');
    expect(() => parseUnits('0.0000001', 6)).toThrow(QuoteInputError);
    expect(() => parseUnits('1e6', 6)).toThrow(QuoteInputError);
    expect(formatUnits('24994459', 6)).toBe('24.994459');
    expect(formatUnits('25000000', 6)).toBe('25');
  });
});

describe('1Click dry quote: upstream failures', () => {
  test('a 1Click 400 is a rejection with its short message', async () => {
    const r = recorder({ status: 400, body: { message: 'recipient is not valid' } });
    await expect(dryQuote(INPUT, { fetch: r.fetch })).rejects.toThrow(new QuoteRejectedError('1Click rejected the quote: recipient is not valid'));
  });

  test('a 1Click 500 or 401 is an upstream failure', async () => {
    await expect(dryQuote(INPUT, { fetch: recorder({ status: 500, body: {} }).fetch })).rejects.toBeInstanceOf(QuoteUpstreamError);
    await expect(dryQuote(INPUT, { fetch: recorder({ status: 401, body: {} }).fetch })).rejects.toBeInstanceOf(QuoteUpstreamError);
  });

  test('a network error is an upstream failure', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(listTokens({ fetch: f })).rejects.toBeInstanceOf(QuoteUpstreamError);
  });

  test('a response that answers a different request is refused', async () => {
    const other = { ...QUOTE, quoteRequest: { ...QUOTE.quoteRequest, amount: '1' } };
    await expect(dryQuote(INPUT, { fetch: recorder({ status: 201, body: other }).fetch })).rejects.toThrow('does not match the request');
    const notDry = { ...QUOTE, quoteRequest: { ...QUOTE.quoteRequest, dry: false } };
    await expect(dryQuote(INPUT, { fetch: recorder({ status: 201, body: notDry }).fetch })).rejects.toBeInstanceOf(QuoteUpstreamError);
  });

  test('a response missing documented fields is refused', async () => {
    const broken = { ...QUOTE, quote: { ...QUOTE.quote, amountOut: '24.9' } };
    await expect(dryQuote(INPUT, { fetch: recorder({ status: 201, body: broken }).fetch })).rejects.toThrow('unexpected shape');
  });

  test('the request body is what buildQuoteRequest documents', () => {
    const body = buildQuoteRequest({ ...INPUT, slippageBps: 100 }, NOW);
    expect(Object.keys(body).sort()).toEqual(
      ['amount', 'deadline', 'depositType', 'destinationAsset', 'dry', 'originAsset', 'recipient', 'recipientType', 'refundTo', 'refundType', 'slippageTolerance', 'swapType'].sort()
    );
  });
});

describe('B23-04: partner key budget and cached token list', () => {
  test('a global sliding window caps how often the partner key goes out', () => {
    let t = 0;
    const b = createBudget(2, 1000, () => t);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    t = 999;
    expect(b.take()).toBe(false);
    t = 1000;
    expect(b.take()).toBe(true); // the first grant left the window
    expect(() => createBudget(0, 1000)).toThrow();
  });

  test('a tokens loader override replaces GET /v0/tokens, so one quote is one upstream call', async () => {
    const r = recorder();
    let loads = 0;
    const tokens = async () => {
      loads += 1;
      return TOKENS as OneClickToken[];
    };
    await dryQuote(INPUT, { fetch: r.fetch, now: () => NOW, tokens });
    await dryQuote(INPUT, { fetch: r.fetch, now: () => NOW, tokens });
    expect(loads).toBe(2);
    expect(r.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v0/quote', '/v0/quote']);
  });
});

// GET /public/quote through the real app, against a local 1Click stand-in serving the captured responses.
describe('GET /public/quote', () => {
  let mode: 'ok' | 'reject' | 'down' = 'ok';
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        if (new URL(req.url).pathname === '/v0/tokens') return Response.json(TOKENS);
        if (mode === 'reject') return Response.json({ message: 'recipient is not valid' }, { status: 400 });
        if (mode === 'down') return new Response('upstream exploded at line 42', { status: 503 });
        return Response.json(QUOTE, { status: 201 });
      },
    });
  });
  afterAll(() => server.stop(true));

  // own process: main-config reads env at import time and exits without it
  const run = async (paths: string[]) => {
    const app = resolve(import.meta.dir, '../src/app.ts');
    const script = `const { buildApp } = await import(${JSON.stringify(app)}); const a = await buildApp(); const out = [];
      for (const url of ${JSON.stringify(paths)}) { const r = await a.inject({ method: 'GET', url }); out.push({ status: r.statusCode, body: r.json() }); }
      process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n'); process.exit(0);`;
    const p = Bun.spawn(['bun', '-e', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
        JWT_SECRET: 'x'.repeat(32),
        SHOP_CONTRACT_ID: 'shop.testnet',
        INBOX_TOKEN_HASH: '0'.repeat(64),
        ONECLICK_API_URL: `http://127.0.0.1:${server.port}`,
      },
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    return JSON.parse(line!.slice(7)) as { status: number; body: { success: boolean; error: { code: string; message: string } | null; data: Record<string, unknown> | null } }[];
  };
  const qs = (o: Record<string, string>) => `/public/quote?${new URLSearchParams(o)}`;

  test('200 with the quote, 400 on bad input, 400 on a 1Click rejection, 502 when 1Click fails', async () => {
    const ok = qs({ payee: PAYEE, destinationAsset: BASE_USDC, amount: '25000000', recipient: RECIPIENT });
    mode = 'ok';
    const [good, badAmount, missing, unknownAsset] = await run([ok, qs({ payee: PAYEE, destinationAsset: BASE_USDC, amount: '25.5', recipient: RECIPIENT }), '/public/quote?payee=bob.near', qs({ payee: PAYEE, destinationAsset: 'nep141:nope.near', amount: '1', recipient: RECIPIENT })]);
    expect(good.status).toBe(200);
    expect(good.body.data).toMatchObject({ dry: true, authenticated: false, amountOut: QUOTE.quote.amountOut as string });
    expect(badAmount.status).toBe(400);
    expect(badAmount.body.error).toEqual({ code: 'VALIDATION_ERROR', message: 'Invalid input: amount' });
    expect(missing.status).toBe(400);
    expect(unknownAsset.status).toBe(400);
    expect(unknownAsset.body.error?.message).toBe('destinationAsset is not in the 1Click token list');

    mode = 'reject';
    const [rejected] = await run([ok]);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toEqual({ code: 'QUOTE_REJECTED', message: '1Click rejected the quote: recipient is not valid' });

    mode = 'down';
    const [down] = await run([ok]);
    expect(down.status).toBe(502);
    expect(down.body.error).toEqual({ code: 'UPSTREAM_ERROR', message: '1Click is unavailable' });
    expect(JSON.stringify(down.body)).not.toContain('line 42');
  }, 30_000);
});

// Live 1Click: run with NETWORK_TESTS=1. Dry quote only: nothing signed, no deposit address, no funds.
describe.skipIf(!process.env.NETWORK_TESTS)('1Click live dry quote', () => {
  test('USDC inside Intents to USDC on Base', async () => {
    const tokens = await listTokens();
    expect(tokens.some((t) => t.assetId === USDC_NEAR_ASSET)).toBe(true);
    const q = await dryQuote(INPUT);
    expect(q.dry).toBe(true);
    expect(q.amountIn).toBe('25000000');
    expect(q.amountOut).toMatch(/^\d+$/);
    expect(BigInt(q.amountOut)).toBeGreaterThan(0n);
    expect(BigInt(q.minAmountOut)).toBeLessThanOrEqual(BigInt(q.amountOut));
    expect(q.timeEstimateSeconds).toBeGreaterThan(0);
    expect(q.signature).toMatch(/^ed25519:/);
    expect(q.correlationId.length).toBeGreaterThan(0);
    console.log(
      JSON.stringify({ amountIn: q.amountInFormatted, amountOut: q.amountOutFormatted, minOut: q.minAmountOutFormatted, withdrawFee: q.fees.withdrawFeeFormatted, appFees: q.fees.appFees, timeEstimateSeconds: q.timeEstimateSeconds, quotedAt: q.quotedAt, correlationId: q.correlationId })
    );
  }, 30_000);
});
