/**
 * ledger-csv: an accountant's CSV of a vault's payments, proposals, declines and test reveals, read from chain
 * (FastNEAR Transactions API for the event logs, RPC for the token's ft_metadata). No database, no key.
 * Usage: bun ledger-csv.ts <vault> [--out ledger.csv] [--from 2026-11-01] [--to 2026-12-01]
 *   Status is as of --to (default now); rows start at --from. Without --out the CSV goes to stdout.
 * Env: NEAR_NETWORK (testnet|mainnet), NEAR_RPC_URL, NEAR_TX_API_URL. Not for the local sandbox (no tx API).
 */
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { NEAR, view } from './lib/net.ts';
import { vaultEvents } from './lib/chainread.ts';
import { buildLedger, LEDGER_EVENTS, toCsv } from '../backend/src/lib/ledger.ts';
import { isValidAccountId } from '../backend/src/utils/ids.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const shop = args[0];
const date = (name: string): Date | undefined => {
  const v = flag(name);
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail(`${name} must be a date, for example 2026-11-01`);
  return d;
};
function fail(msg: string): never {
  process.stderr.write(`${msg}\nusage: bun ledger-csv.ts <vault> [--out ledger.csv] [--from YYYY-MM-DD] [--to YYYY-MM-DD]\n`);
  process.exit(2);
}

if (!shop || !isValidAccountId(shop)) fail('first argument must be the vault account id');
const from = date('--from');
const to = date('--to');
if (from && to && from >= to) fail('--from must be before --to');

const status = await view<{ token_id: string }>(shop, 'get_status');
const token = z.object({ symbol: z.string().min(1).max(32), decimals: z.number().int().min(0).max(38) }).parse(await view<unknown>(status.token_id, 'ft_metadata'));
const wanted = new Set<string>(LEDGER_EVENTS);
const events = (await vaultEvents(shop)).filter((e) => wanted.has(e.event) && (!to || e.blockTime < to));
const fromUtc = from ? from.toISOString().replace('T', ' ').slice(0, 19) : null;
const rows = buildLedger(events, { tokenSymbol: token.symbol, decimals: token.decimals, explorerUrl: NEAR.explorerUrl }).filter((r) => !fromUtc || r.date_utc >= fromUtc);
const csv = toCsv(rows);

const out = flag('--out');
if (out) {
  writeFileSync(out, csv);
  process.stderr.write(`${rows.length} row(s) from ${events.length} event(s) written to ${out} (${NEAR.network}, ${token.symbol}, ${token.decimals} decimals)\n`);
} else {
  process.stdout.write(csv);
}
