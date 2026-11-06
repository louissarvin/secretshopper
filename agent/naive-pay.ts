// NAIVE AGENT, testnet evidence only: pays the next inbox item exactly as written, with no model and no preflight,
// the way a fooled or compromised agent would. Run it against your own vault with the real agent stopped:
//   bun --env-file=.env naive-pay.ts [--wait]      (--wait polls until an item is delivered)
// Signs one `pay` with the agent key; the vault's limits still apply. Refuses mainnet.
import { AGENT_PRIVATE_KEY, AGENT_VAULT_ID, CALL_TGAS, PAY_TGAS, NEAR_NETWORK, NEAR_RPC_URL, TOKEN_DECIMALS } from './src/config.ts';
import { nextInvoice, type Cursor, type InboxItem } from './src/inbox.ts';
import { toBaseUnits } from './src/tools.ts';
import { createVault } from './src/vault.ts';

if (NEAR_NETWORK === 'mainnet') throw new Error('naive-pay is testnet evidence only');
const vault = createVault({ rpcUrl: NEAR_RPC_URL, vaultId: AGENT_VAULT_ID, privateKey: AGENT_PRIVATE_KEY, payTgas: PAY_TGAS, callTgas: CALL_TGAS, listedOnly: false });
const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...data }));

// Walk the inbox from the start and take the first item nobody has decided yet (the real agent may have run before).
// a decision never goes away, so each decided id costs one RPC read, not one per poll
const decided = new Set<string>();
const firstUndecided = async (): Promise<InboxItem | null> => {
  let cursor: Cursor | null = null;
  for (;;) {
    const it = await nextInvoice(cursor);
    if (!it) return null;
    if (!decided.has(it.id)) {
      if (!(await vault.getDecision(it.id))) return it;
      decided.add(it.id);
    }
    cursor = { afterAt: it.receivedAt, afterId: it.id };
  }
};

const wait = process.argv.includes('--wait');
let item: InboxItem | null = null;
for (;;) {
  try {
    item = await firstUndecided();
  } catch (e) {
    if (!wait) throw e;
    log('poll failed, backing off', { error: (e as Error).message.slice(0, 160) }); // e.g. a shared RPC 429
    await Bun.sleep(90_000);
    continue;
  }
  if (item || !wait) break;
  await Bun.sleep(30_000);
}
if (!item) {
  log('no undecided item in the inbox');
  process.exit(0);
}

// vendors bill in their own layouts: pay_to, remit_to or payment.account; total or amount_due
const doc = item.document as { pay_to?: string; remit_to?: string; payment?: { account?: string }; total?: string | number; amount_due?: string | number; number?: string; invoice_no?: string; ref?: string };
const payee = String(doc.pay_to ?? doc.remit_to ?? doc.payment?.account ?? '');
const amount = toBaseUnits(String(doc.amount_due ?? doc.total ?? ''), TOKEN_DECIMALS);
log('NAIVE AGENT pays the item as written', { invoice: item.id, receivedAt: item.receivedAt, number: doc.number ?? doc.invoice_no ?? doc.ref, payee, amount });
const r = await vault.pay(item.id, payee, amount, 'Near');
log('pay sent', { result: r as unknown as Record<string, unknown> });
