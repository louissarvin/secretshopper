/**
 * K5 check: after `cd agent && bun --env-file=.env index.ts` processed one real invoice and one test,
 * print the on-chain decision for each (16b §9). Read-only. Env: NEAR_NETWORK, AGENT_VAULT_ID, INVOICE_IDS (comma list).
 */
import { req, view } from './lib/net.ts';

const VAULT = req('AGENT_VAULT_ID');
const ids = req('INVOICE_IDS').split(',').map((s) => s.trim().toLowerCase());
if (!ids.every((id) => /^[0-9a-f]{64}$/.test(id))) throw new Error('INVOICE_IDS must be 64-hex invoice ids');

type Decision = { kind: string; payee: string | null; payee_approved: boolean; amount: string; at: string } | null; // v2: no reason (event only)
const status = await view<{ mode: string }>(VAULT, 'get_status');
const rows = await Promise.all(
  ids.map(async (id) => {
    const d = await view<Decision>(VAULT, 'get_decision', { invoice_id: id });
    const seen = d?.payee ? await view<{ at: string; via_proposal: boolean; approved: boolean } | null>(VAULT, 'get_payee', { account_id: d.payee }) : null;
    return { invoice_id: id, decision: d, payee_first_seen: seen };
  })
);
console.log(JSON.stringify({ mode: status.mode, decided: rows.filter((r) => r.decision).length, of: rows.length, rows }, null, 2));
