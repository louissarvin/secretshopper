/**
 * Live self-serve check: asks the API for a vault plan and signs exactly those transactions with the owner's key,
 * mapping each NEAR Connect action one to one, as a wallet would. Then reads the vault back through the API.
 * Signs testnet transactions (spends the plan's totalYocto from the owner). Refuses mainnet.
 * Usage: NEAR_NETWORK=testnet bun selfserve-e2e.ts <name> <vendorId> [fundNear]
 */
import { Account, actions, baseDecode, type KeyPairString } from 'near-api-js';
import { NEAR, provider } from './lib/net.ts';
import { loadLegacyKey } from './lib/creds.ts';
import { api } from './lib/owner.ts';

type ConnectorAction =
  | { type: 'CreateAccount' }
  | { type: 'Transfer'; params: { deposit: string } }
  | { type: 'UseGlobalContract'; params: { contractIdentifier: { codeHash: string } } }
  | { type: 'FunctionCall'; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } };
type Plan = { signerId: string; vaultId: string; totalYocto: string; transactions: { receiverId: string; actions: ConnectorAction[] }[] };

if (NEAR.network !== 'testnet') throw new Error('selfserve-e2e runs on testnet only');
const [name, vendorId, fundNear = '1'] = process.argv.slice(2);
if (!name || !vendorId) throw new Error('usage: bun selfserve-e2e.ts <name> <vendorId> [fundNear]');
const ownerId = (await api<{ owner: string }>('GET', '/public/config')).body.data.owner;

const toAction = (a: ConnectorAction) => {
  switch (a.type) {
    case 'CreateAccount': return actions.createAccount();
    case 'Transfer': return actions.transfer(BigInt(a.params.deposit));
    case 'UseGlobalContract': return actions.useGlobalContract({ codeHash: baseDecode(a.params.contractIdentifier.codeHash) });
    case 'FunctionCall': return actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit));
  }
};

const res = await api<Plan>('POST', '/public/vault-plan', { ownerId, name, vendorId, fundNear });
if (res.status !== 200) throw new Error(`plan refused: ${res.status} ${JSON.stringify(res.body.error)}`);
const plan = res.body.data;
console.log(`plan: ${plan.vaultId}, ${plan.transactions.length} txs, total ${Number(BigInt(plan.totalYocto) / 10n ** 20n) / 1e4} NEAR`);

const owner = new Account(plan.signerId, provider, loadLegacyKey(NEAR.network, plan.signerId) as KeyPairString);
for (const [i, tx] of plan.transactions.entries()) {
  const out = await owner.signAndSendTransaction({ receiverId: tx.receiverId, actions: tx.actions.map(toAction), waitUntil: 'FINAL' });
  const ok = typeof out.status === 'object' && 'SuccessValue' in out.status;
  console.log(`tx ${i + 1} ${tx.receiverId} [${tx.actions.map((a) => a.type).join(', ')}]: ${ok ? 'ok' : 'FAILED'} ${out.transaction.hash}`);
  if (!ok) { console.log(JSON.stringify(out.status)); process.exit(1); }
}

const view = await api<{ codeHash: string; keys: unknown[]; status: { mode: string; owner_id: string; vendor_id: string; version: string }; createdTx: string | null }>('GET', `/public/vault/${plan.vaultId}`);
const v = view.body.data;
const pass = view.status === 200 && v.keys.length === 0 && v.status.owner_id === ownerId && v.status.vendor_id === vendorId;
console.log(`vault view: ${view.status}, version ${v?.status.version}, mode ${v?.status.mode}, keys ${v?.keys.length}, code ${v?.codeHash}`);
console.log(pass ? `PASS: ${plan.vaultId} created from the API plan, no keys, owner and vendor as planned` : 'FAIL');
process.exit(pass ? 0 : 1);
