/**
 * Registers the vault's company in the local API without the web app: NEP-413 sign-in with the owner's key
 * from ~/.near-credentials, then POST /company. Idempotent. Never prints key material or the JWT.
 * Usage: bun owner-register.ts <shop> [--name "Company name"] [--deploy-block N]
 * Env: NEAR_NETWORK (default testnet), API_URL (default http://localhost:3700).
 */
import { NEAR, req, view } from './lib/net.ts';
import { loadLegacyKey } from './lib/creds.ts';
import { api, API_URL, signIn } from './lib/owner.ts';

const shop = process.argv[2] || req('SHOP_CONTRACT_ID');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

// Deploy block = the vault account's first transaction (FastNEAR Transactions API), so the indexer starts there.
const firstTxBlock = async (accountId: string): Promise<number> => {
  const res = await fetch(`${NEAR.txApiUrl}/v0/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, desc: false, limit: 1 }),
  });
  const row = ((await res.json()) as { account_txs: { tx_block_height: number }[] }).account_txs[0];
  if (!row) throw new Error(`no transactions found for ${accountId}`);
  return row.tx_block_height;
};

const status = await view<{ owner_id: string; vendor_id: string; version: string }>(shop, 'get_status');
const owner = status.owner_id;
const token = await signIn(owner, loadLegacyKey(NEAR.network, owner));
console.log(JSON.stringify({ step: 'signed in', api: API_URL, account: owner, method: 'NEP-413 with the full-access key from ~/.near-credentials' }));

const me = await api<{ shopContractId: string; deployBlock: string } | null>('GET', '/company/me', undefined, token);
if (me.body.data) {
  console.log(JSON.stringify({ step: 'already registered', company: me.body.data }));
  process.exit(0);
}
const deployBlock = Number(arg('--deploy-block') ?? (await firstTxBlock(shop)));
const created = await api('POST', '/company', { name: arg('--name') || 'Secret Shopper Demo Co (testnet)', deployBlock }, token);
if (!created.body.success) {
  console.error(JSON.stringify({ step: 'register failed', status: created.status, error: created.body.error }));
  process.exit(1);
}
console.log(JSON.stringify({ step: 'registered', shop, vendor: status.vendor_id, vault_version: status.version, company: created.body.data }));
