/**
 * Prints one 1Click dry payout quote: USDC held by a payee inside NEAR Intents, withdrawn to another chain.
 * `dry: true`, so nothing is signed, no deposit address is made and no funds move. Needs only network access.
 *
 * Usage: bun intents-quote.ts --payee <near account> --to <assetId | SYMBOL:chain> --amount <USDC, e.g. 25.5>
 *          --recipient <address on the destination chain> [--slippage <bps, default 100>]
 *        bun intents-quote.ts --list [chain]      lists the destination assets 1Click supports
 * Env (optional): ONECLICK_JWT (partner key, else the unauthenticated fee), ONECLICK_API_URL.
 */
import { readFileSync } from 'node:fs';
import { dryQuote, listTokens, parseUnits, QuoteInputError, QuoteRejectedError, USDC_NEAR_ASSET, type OneClickToken } from '../backend/src/lib/intents/quote.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const usage = (msg: string): never => {
  console.error(`${msg}\n${readFileSync(import.meta.path, 'utf8').split('*/')[0]}`);
  process.exit(2);
};
const deps = { jwt: process.env.ONECLICK_JWT || '', baseUrl: process.env.ONECLICK_API_URL || '' };

try {
  const tokens = await listTokens(deps);
  if (process.argv.includes('--list')) {
    const chain = arg('--list');
    const rows = tokens.filter((t) => !chain || chain.startsWith('--') || t.blockchain === chain).sort((a, b) => a.blockchain.localeCompare(b.blockchain) || a.symbol.localeCompare(b.symbol));
    rows.forEach((t) => console.log(`${t.blockchain.padEnd(10)} ${t.symbol.padEnd(10)} ${t.assetId}`));
    process.exit(0);
  }

  const to = arg('--to') ?? usage('missing --to');
  const resolve = (s: string): OneClickToken => {
    const exact = tokens.find((t) => t.assetId === s);
    if (exact) return exact;
    const [symbol, chain] = s.split(':');
    const hits = tokens.filter((t) => t.symbol.toLowerCase() === symbol?.toLowerCase() && t.blockchain === chain);
    if (hits.length !== 1) usage(`--to ${s} matches ${hits.length} assets; pass an assetId from --list`);
    return hits[0];
  };
  const dest = resolve(to);
  const usdc = tokens.find((t) => t.assetId === USDC_NEAR_ASSET) ?? usage('1Click does not list USDC on NEAR');
  const amount = parseUnits(arg('--amount') ?? usage('missing --amount'), usdc.decimals);
  const slippage = arg('--slippage');

  const q = await dryQuote(
    {
      payee: arg('--payee') ?? usage('missing --payee'),
      destinationAsset: dest.assetId,
      amount,
      recipient: arg('--recipient') ?? usage('missing --recipient'),
      ...(slippage !== undefined ? { slippageBps: Number(slippage) } : {}),
    },
    deps
  );
  const rows: [string, string][] = [
    ['mode', `dry quote (nothing signed, no deposit address)`],
    ['auth', q.authenticated ? 'partner key' : 'none'],
    ['from', `${q.amountInFormatted} ${q.origin.symbol} on ${q.origin.blockchain}, held by ${q.payee} inside Intents`],
    ['to', `${q.destination.symbol} on ${q.destination.blockchain}, recipient ${q.recipient}`],
    ['amount out', `${q.amountOutFormatted} ${q.destination.symbol} (USD ${q.amountOutUsd})`],
    ['min out', `${q.minAmountOutFormatted} ${q.destination.symbol} at ${q.slippageBps} bps slippage`],
    ['withdraw fee', q.fees.withdrawFeeFormatted ? `${q.fees.withdrawFeeFormatted} ${q.destination.symbol} (already in amount out)` : 'none reported'],
    ['app fees', q.fees.appFees.length ? q.fees.appFees.map((f) => `${f.fee} bps to ${f.recipient}`).join(', ') : 'none'],
    ['time', `about ${q.timeEstimateSeconds} s after the withdrawal starts`],
    ['quoted at', q.quotedAt],
    ['valid until', `${q.validUntil} (request deadline; dry quotes are previews, not offers)`],
    ['correlation', q.correlationId],
  ];
  rows.forEach(([k, v]) => console.log(`${k.padEnd(13)}${v}`));
  console.log(`\n${q.feeNote}`);
} catch (e) {
  if (e instanceof QuoteInputError || e instanceof QuoteRejectedError) usage(e.message);
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
