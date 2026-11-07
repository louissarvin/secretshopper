/**
 * Sets up demo vendors for a live vault without the web app. For each fictional vendor:
 *   1. creates its payee account as a sub-account of the owner (key saved to the owner's legacy keychain, so
 *      tokens paid there stay recoverable by the owner),
 *   2. calls add_payee on the vault (owner full-access key, 1 yocto; active after policy.payee_delay),
 *   3. mirrors it as a Vendor row (POST /vendors) with a public style set.
 * Idempotent. Signs testnet transactions; never prints key material or the JWT.
 * Usage: bun owner-payees.ts <shop>     Env: NEAR_NETWORK (default testnet), API_URL.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Account, KeyPair, nearToYocto, teraToGas } from 'near-api-js';
import { NEAR, provider, req, txUrl, view } from './lib/net.ts';
import { credentialPath, loadLegacyKey } from './lib/creds.ts';
import { api, signIn } from './lib/owner.ts';

// Clearly fictional companies (Microsoft sample-data names). Amounts stay under the vault's max_per_payment.
const VENDORS = [
  {
    sub: 'northwind',
    legalName: 'Northwind Office Supply',
    contactEmail: 'billing@northwind-office.example',
    styleSet: [
      { number: 'NW-2026-0187', issued: '2026-10-03', due: '2026-11-02', bill_to: '<company>', lines: [{ description: 'Printer paper, 10 reams', qty: 1, unit_price: '0.92' }], total: '0.92', currency: 'USDC', pay_to: '<account>' },
      { number: 'NW-2026-0201', issued: '2026-10-17', due: '2026-11-16', bill_to: '<company>', lines: [{ description: 'Desk organisers', qty: 3, unit_price: '0.41' }], total: '1.23', currency: 'USDC', pay_to: '<account>' },
    ],
  },
  {
    sub: 'contoso-cloud',
    legalName: 'Contoso Cloud Hosting',
    contactEmail: 'invoices@contoso-cloud.example',
    styleSet: [
      { invoice_no: 'CC-55120', period: '2026-09', items: [{ sku: 'vm-small', hours: 720, amount: '1.44' }], amount_due: '1.44', total: '1.44', currency: 'USDC', remit_to: '<account>' },
      { invoice_no: 'CC-55387', period: '2026-10', items: [{ sku: 'vm-small', hours: 744, amount: '1.49' }], amount_due: '1.49', total: '1.49', currency: 'USDC', remit_to: '<account>' },
    ],
  },
  {
    sub: 'fabrikam',
    legalName: 'Fabrikam Facilities Services',
    contactEmail: 'ar@fabrikam-facilities.example',
    styleSet: [
      { ref: 'FAB/10/2026/044', service: 'Office cleaning, October', total: '1.75', currency: 'USDC', payment: { account: '<account>', terms: 'net 14' } },
      { ref: 'FAB/09/2026/039', service: 'Office cleaning, September', total: '1.75', currency: 'USDC', payment: { account: '<account>', terms: 'net 14' } },
    ],
  },
];

const shop = process.argv[2] || req('SHOP_CONTRACT_ID');
const status = await view<{ owner_id: string }>(shop, 'get_status');
const ownerId = status.owner_id;
const ownerKey = loadLegacyKey(NEAR.network, ownerId);
const owner = new Account(ownerId, provider, ownerKey);
const token = await signIn(ownerId, ownerKey);

const accountExists = async (id: string) => provider.viewAccount({ accountId: id }).then(() => true, () => false);

type VendorRow = { id: string; legalName: string };
const existing = (await api<{ items: VendorRow[] }>('GET', '/vendors?limit=100', undefined, token)).body.data.items;

for (const v of VENDORS) {
  const payee = `${v.sub}.${ownerId}`;
  const out: Record<string, unknown> = { vendor: v.legalName, payee };

  if (!(await accountExists(payee))) {
    const kp = KeyPair.fromRandom('ed25519');
    const path = credentialPath(NEAR.network, payee);
    if (existsSync(path)) throw new Error(`${path} exists but ${payee} does not; refusing to overwrite a key`);
    const tx = await owner.createAccount({ newAccountId: payee, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto('0.05') });
    // same format near-cli writes; 0600 so only the user can read it
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ account_id: payee, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    out.account_created = txUrl(tx.transaction.hash);
  }

  const approved = await view<{ active_at: string; removed_at: string | null } | null>(shop, 'get_payee_status', { account_id: payee });
  if (!approved) {
    const tx = await owner.callFunctionRaw({
      contractId: shop,
      methodName: 'add_payee',
      args: { account_id: payee, label: v.legalName },
      deposit: 1n,
      gas: teraToGas(30),
      waitUntil: 'FINAL',
    });
    out.add_payee = txUrl(tx.transaction.hash);
  }
  const after = await view<{ active_at: string; removed_at: string | null }>(shop, 'get_payee_status', { account_id: payee });
  out.active_at = new Date(Number(BigInt(after.active_at) / 1_000_000n)).toISOString();

  const row = existing.find((e) => e.legalName === v.legalName);
  const body = { legalName: v.legalName, contactEmail: v.contactEmail, approvedPayees: [{ account: payee, rail: 'Near' }], sampleInvoices: v.styleSet, styleSet: v.styleSet };
  const saved = row
    ? await api<VendorRow>('PUT', `/vendors/${row.id}`, body, token)
    : await api<VendorRow>('POST', '/vendors', body, token);
  if (!saved.body.success) throw new Error(`vendor ${v.legalName}: ${saved.status} ${saved.body.error?.message}`);
  out.vendor_row = { id: saved.body.data.id, action: row ? 'updated' : 'created' };
  console.log(JSON.stringify(out));
}
