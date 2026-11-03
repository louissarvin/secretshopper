/**
 * Payout quote preview: what a payee holding USDC inside NEAR Intents would receive on another chain.
 * Uses the 1Click Swap API with `dry: true`, so no deposit address is created, nothing is signed and no funds move.
 * Request and response shapes: reference/docs.near-intents.org/api-reference/oneclick/request-a-swap-quote.md
 * and get-supported-tokens.md. Reads no env and imports no config, so scripts can use it; callers pass the JWT.
 */
import { z } from 'zod';
import { isValidAccountId } from '../../utils/ids.ts';
import { checkUrl } from '../../config/network.ts';

export const ONECLICK_URL = 'https://1click.chaindefuser.com';
// Native USDC on NEAR, as listed by GET /v0/tokens (reference/docs.near-intents.org/api-reference/get-transactions.md)
export const USDC_NEAR_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
// integration/distribution-channels/1click-api/authentication.md
export const UNAUTHENTICATED_FEE_BPS = 25;
// A dry quote has no deadline of its own; this is the `deadline` (required field) the request carries.
export const QUOTE_DEADLINE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15_000;

export class QuoteInputError extends Error {}
/** 1Click answered 400: the request was well formed for us but 1Click refused it (bad address, amount too small). */
export class QuoteRejectedError extends Error {}
export class QuoteUpstreamError extends Error {}

const assetIdSchema = z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, 'printable ASCII, no spaces');

export const quoteInputSchema = z
  .object({
    // the payee's Intents account: refunds go back there (refundType INTENTS)
    payee: z.string().refine(isValidAccountId, 'invalid NEAR account id'),
    destinationAsset: assetIdSchema,
    // smallest units of USDC; the docs say decimals like "0.01" are invalid
    amount: z.string().regex(/^[1-9]\d{0,38}$/, 'expected a positive integer string in base units'),
    // format must match the destination chain; 1Click validates it, we only bound it
    recipient: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/, 'printable ASCII, no spaces'),
    slippageBps: z.number().int().min(0).max(1000).default(100),
  })
  .strict();
export type QuoteInput = z.input<typeof quoteInputSchema>;

const tokenSchema = z.object({
  assetId: z.string(),
  decimals: z.number().int().min(0).max(38),
  blockchain: z.string(),
  symbol: z.string(),
  price: z.number().optional(),
  contractAddress: z.string().nullish(),
});
export type OneClickToken = z.infer<typeof tokenSchema>;

const units = z.string().regex(/^\d{1,40}$/);
const quoteResponseSchema = z.object({
  correlationId: z.string(),
  timestamp: z.string(),
  signature: z.string(),
  quoteRequest: z.object({
    dry: z.boolean(),
    originAsset: z.string(),
    destinationAsset: z.string(),
    amount: z.string(),
    recipient: z.string(),
    appFees: z.array(z.object({ recipient: z.string(), fee: z.number() })).optional(),
  }),
  quote: z.object({
    amountIn: units,
    amountInFormatted: z.string(),
    amountInUsd: z.string(),
    minAmountIn: units,
    amountOut: units,
    amountOutFormatted: z.string(),
    amountOutUsd: z.string(),
    minAmountOut: units,
    timeEstimate: z.number(),
    withdrawFee: units.optional(),
    refundFee: units.optional(),
  }),
});

export interface QuoteDeps {
  fetch?: typeof fetch;
  /** Partner JWT (ONECLICK_JWT). Without it 1Click applies the unauthenticated fee. */
  jwt?: string;
  baseUrl?: string;
  now?: () => Date;
  /** Token list loader override, so a server can cache GET /v0/tokens instead of fetching it per quote (B23-04). */
  tokens?: () => Promise<OneClickToken[]>;
}

/**
 * Sliding-window budget shared by every caller: at most `max` grants per `windowMs`.
 * Used to cap how often the partner key is spent, whatever the per-IP limit allows (B23-04).
 */
export const createBudget = (max: number, windowMs: number, now: () => number = Date.now) => {
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(windowMs) || windowMs < 1) throw new Error('budget needs positive integers');
  const grants: number[] = [];
  return {
    /** True and counted when the window has room; false otherwise. */
    take: (): boolean => {
      const t = now();
      while (grants.length && t - grants[0] >= windowMs) grants.shift();
      if (grants.length >= max) return false;
      grants.push(t);
      return true;
    },
  };
};

export interface PayoutQuote {
  dry: true;
  authenticated: boolean;
  feeNote: string;
  payee: string;
  recipient: string;
  origin: { assetId: string; symbol: string; blockchain: string; decimals: number };
  destination: { assetId: string; symbol: string; blockchain: string; decimals: number };
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  minAmountOutFormatted: string;
  fees: {
    withdrawFee: string | null;
    withdrawFeeFormatted: string | null;
    refundFee: string | null;
    appFees: { recipient: string; fee: number }[];
  };
  slippageBps: number;
  timeEstimateSeconds: number;
  quotedAt: string;
  validUntil: string;
  correlationId: string;
  signature: string;
  raw: unknown;
}

/** Base units to a decimal string, exact (no floats). */
export const formatUnits = (units: string, decimals: number): string => {
  const v = BigInt(units);
  const d = 10n ** BigInt(decimals);
  const frac = (v % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${v / d}.${frac}` : `${v / d}`;
};

/** Decimal string to base units, exact; refuses more fractional digits than the token has. */
export const parseUnits = (value: string, decimals: number): string => {
  const m = /^(\d{1,30})(?:\.(\d+))?$/.exec(value);
  if (!m) throw new QuoteInputError('amount must be a decimal number like 12.5');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new QuoteInputError(`amount has more than ${decimals} decimals`);
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
};

const resolveDeps = (deps: QuoteDeps) => {
  return {
    fetch: deps.fetch ?? fetch,
    jwt: deps.jwt ?? '',
    baseUrl: checkUrl('ONECLICK_API_URL', deps.baseUrl || ONECLICK_URL),
    now: deps.now ?? (() => new Date()),
  };
};

const upstream = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    if (e instanceof QuoteRejectedError || e instanceof QuoteUpstreamError) throw e;
    throw new QuoteUpstreamError(`1Click ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** GET /v0/tokens: every asset 1Click can route. */
export const listTokens = async (deps: QuoteDeps = {}): Promise<OneClickToken[]> => {
  const d = resolveDeps(deps);
  return upstream('tokens', async () => {
    const res = await d.fetch(`${d.baseUrl}/v0/tokens`, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new QuoteUpstreamError(`1Click tokens answered HTTP ${res.status}`);
    const parsed = z.array(tokenSchema).safeParse(await res.json());
    if (!parsed.success) throw new QuoteUpstreamError('1Click tokens response has an unexpected shape');
    return parsed.data;
  });
};

// Upstream text is shown to callers, so keep it short and printable.
const plain = (s: unknown): string => (typeof s === 'string' ? s.replace(/[^\x20-\x7e]/g, '').slice(0, 200) : 'no reason given');

/** Builds the exact POST /v0/quote body for a dry payout of USDC held inside Intents. */
export const buildQuoteRequest = (input: z.output<typeof quoteInputSchema>, now: Date) => ({
  dry: true,
  swapType: 'EXACT_INPUT',
  slippageTolerance: input.slippageBps,
  originAsset: USDC_NEAR_ASSET,
  depositType: 'INTENTS',
  destinationAsset: input.destinationAsset,
  amount: input.amount,
  recipient: input.recipient,
  recipientType: 'DESTINATION_CHAIN',
  refundTo: input.payee,
  refundType: 'INTENTS',
  deadline: new Date(now.getTime() + QUOTE_DEADLINE_MS).toISOString(),
});

/**
 * One dry quote: `amount` USDC (base units) held by `payee` inside Intents, withdrawn as `destinationAsset` to
 * `recipient` on its chain. Throws QuoteInputError (bad input), QuoteRejectedError (1Click 400) or QuoteUpstreamError.
 */
export const dryQuote = async (input: QuoteInput, deps: QuoteDeps = {}): Promise<PayoutQuote> => {
  const parsedInput = quoteInputSchema.safeParse(input);
  if (!parsedInput.success) {
    const fields = [...new Set(parsedInput.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new QuoteInputError(`Invalid input: ${fields.join(', ')}`);
  }
  const q = parsedInput.data;
  const d = resolveDeps(deps);

  const tokens = deps.tokens ? await deps.tokens() : await listTokens(deps);
  const origin = tokens.find((t) => t.assetId === USDC_NEAR_ASSET);
  if (!origin) throw new QuoteUpstreamError('1Click no longer lists USDC on NEAR');
  const destination = tokens.find((t) => t.assetId === q.destinationAsset);
  if (!destination) throw new QuoteInputError('destinationAsset is not in the 1Click token list');
  // a NEAR recipient must be a NEAR account id; other chains are checked by 1Click
  if (destination.blockchain === 'near' && !isValidAccountId(q.recipient)) throw new QuoteInputError('recipient must be a NEAR account id for a NEAR asset');

  const body = buildQuoteRequest(q, d.now());
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // X-API-Key is the recommended header (authentication.md); never sent without a configured JWT
  if (d.jwt) headers['X-API-Key'] = d.jwt;

  const raw = await upstream('quote', async () => {
    const res = await d.fetch(`${d.baseUrl}/v0/quote`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 400) throw new QuoteRejectedError(`1Click rejected the quote: ${plain((json as { message?: unknown } | null)?.message)}`);
    if (!res.ok) throw new QuoteUpstreamError(`1Click quote answered HTTP ${res.status}`);
    return json;
  });
  const parsed = quoteResponseSchema.safeParse(raw);
  if (!parsed.success) throw new QuoteUpstreamError('1Click quote response has an unexpected shape');
  const r = parsed.data;
  // the echoed request must be the dry quote we asked for, or the numbers describe something else
  const echo = r.quoteRequest;
  if (echo.dry !== true || echo.originAsset !== body.originAsset || echo.destinationAsset !== body.destinationAsset || echo.amount !== body.amount || echo.recipient !== body.recipient)
    throw new QuoteUpstreamError('1Click quote does not match the request');

  const authenticated = d.jwt !== '';
  return {
    dry: true,
    authenticated,
    feeNote: authenticated
      ? 'Partner key sent: the 1Click partner fee schedule applies. fees.appFees lists what this quote charged.'
      : `No partner key: the 1Click docs say unauthenticated quotes carry an extra ${UNAUTHENTICATED_FEE_BPS / 100}% (${UNAUTHENTICATED_FEE_BPS} bps) fee. fees.appFees lists what this quote charged.`,
    payee: q.payee,
    recipient: q.recipient,
    origin: { assetId: origin.assetId, symbol: origin.symbol, blockchain: origin.blockchain, decimals: origin.decimals },
    destination: { assetId: destination.assetId, symbol: destination.symbol, blockchain: destination.blockchain, decimals: destination.decimals },
    amountIn: r.quote.amountIn,
    amountInFormatted: r.quote.amountInFormatted,
    amountInUsd: r.quote.amountInUsd,
    amountOut: r.quote.amountOut,
    amountOutFormatted: r.quote.amountOutFormatted,
    amountOutUsd: r.quote.amountOutUsd,
    minAmountOut: r.quote.minAmountOut,
    minAmountOutFormatted: formatUnits(r.quote.minAmountOut, destination.decimals),
    fees: {
      withdrawFee: r.quote.withdrawFee ?? null,
      // the docs: in destination units, already deducted from amountOut
      withdrawFeeFormatted: r.quote.withdrawFee ? formatUnits(r.quote.withdrawFee, destination.decimals) : null,
      refundFee: r.quote.refundFee ?? null,
      appFees: echo.appFees ?? [],
    },
    slippageBps: q.slippageBps,
    timeEstimateSeconds: r.quote.timeEstimate,
    quotedAt: r.timestamp,
    validUntil: body.deadline,
    correlationId: r.correlationId,
    signature: r.signature,
    raw,
  };
};
