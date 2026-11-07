/**
 * Creates a Secret Shopper vault in one step, replacing the manual near-cli sequence (v2/19).
 *   Global (preferred): --code-hash <bs58 of a NEP-591 global contract published by hash>. One tx from the owner
 *     creates the vault, funds it, attaches the code and calls `new`; the vault never holds a key.
 *   Classic: --wasm <path>. A one-time key deploys, inits and deletes itself in one tx.
 * Then registers the vault on the token (storage_deposit) and prints what a verifier checks.
 * Dry run unless --send. Mainnet also needs --mainnet (never without the human's go-ahead).
 * --intents <account> enables the Intents rail: intents.near on mainnet only; testnet has no Intents deployment,
 *   so it needs --allow-unverified-intents (local sandbox experiments only).
 *
 * Usage: bun create-vault.ts --owner <id> --vault <name>.<owner> --vendor <id> --token <id> --policy <file.json>
 *          (--code-hash <bs58> | --wasm <path>) --fund <NEAR> [--intents <id> [--allow-unverified-intents]] [--send] [--mainnet]
 * Env: NEAR_NETWORK, NEAR_RPC_URL. Owner key: ~/.near-credentials/<network>/<owner>.json (never argv).
 */
import { readFileSync } from 'node:fs';
import { Account, baseDecode, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { NEAR, provider, txUrl, view } from './lib/net.ts';
import { loadLegacyKey } from './lib/creds.ts';
import { checkIntents, checkPolicy, codeHashB58, createVault, globalCodePublished, inspectVault, minFunding, type Code, type Policy } from './lib/vault-deploy.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const need = (name: string): string => {
  const v = arg(name);
  if (!v) {
    console.error(`missing ${name}\n${readFileSync(import.meta.path, 'utf8').split('*/')[0]}`);
    process.exit(2);
  }
  return v;
};
const send = process.argv.includes('--send');
if (NEAR.network === 'mainnet' && !process.argv.includes('--mainnet')) {
  console.error('refusing mainnet without --mainnet');
  process.exit(2);
}

const ownerId = need('--owner');
const vaultId = need('--vault');
const vendorId = need('--vendor');
const tokenId = need('--token');
const policy = JSON.parse(readFileSync(need('--policy'), 'utf8')) as Policy;
const fund = nearToYocto(need('--fund') as `${number}`);
if (process.argv.includes('--intents') && !arg('--intents')) {
  console.error('--intents needs an account id');
  process.exit(2);
}
const intentsId = arg('--intents') ?? null;
const allowUnverifiedIntents = process.argv.includes('--allow-unverified-intents');
const hashArg = arg('--code-hash');
const wasmArg = arg('--wasm');
if (!!hashArg === !!wasmArg) {
  console.error('pass exactly one of --code-hash or --wasm');
  process.exit(2);
}
const code: Code = hashArg ? { kind: 'global', codeHash: baseDecode(hashArg) } : { kind: 'classic', wasm: new Uint8Array(readFileSync(wasmArg!)) };
const near = (y: bigint) => `${(Number(y) / 1e24).toFixed(4)} NEAR`;

// Read-only preflight: every reason to refuse is found before signing.
const problems = checkPolicy(policy);
const intentsProblems = checkIntents(NEAR.network, intentsId, allowUnverifiedIntents);
problems.push(...intentsProblems);
const exists = async (id: string) => provider.viewAccount({ accountId: id }).then(() => true, () => false);
if (intentsId && !intentsProblems.length && !(await exists(intentsId))) problems.push(`intents account ${intentsId} does not exist on ${NEAR.network}`);
if (await exists(vaultId)) problems.push(`${vaultId} already exists`);
if (code.kind === 'global' && !(await globalCodePublished(provider, codeHashB58(code)))) problems.push(`no global contract with hash ${codeHashB58(code)} on ${NEAR.network}: publish it first (near contract deploy-as-global ... as-global-hash)`);
if (!(await exists(vendorId))) problems.push(`vendor ${vendorId} does not exist`);
const meta = await view<{ symbol: string; decimals: number }>(tokenId, 'ft_metadata').catch(() => null);
if (!meta) problems.push(`token ${tokenId} has no ft_metadata`);
if (fund < minFunding(code, policy)) problems.push(`fund at least ${near(minFunding(code, policy))}`);
const ownerBalance = BigInt((await provider.viewAccount({ accountId: ownerId })).amount);
if (ownerBalance < fund + nearToYocto('0.05')) problems.push(`owner ${ownerId} holds ${near(ownerBalance)}, needs ${near(fund)} plus fees`);

console.log(`network      ${NEAR.network}`);
console.log(`vault        ${vaultId} (${code.kind}, code hash ${codeHashB58(code)})`);
console.log(`owner        ${ownerId} (${near(ownerBalance)})`);
console.log(`vendor       ${vendorId}`);
console.log(`token        ${tokenId}${meta ? ` (${meta.symbol}, ${meta.decimals} decimals)` : ''}`);
console.log(`fund         ${near(fund)} (minimum ${near(minFunding(code, policy))})`);
console.log(`rails        Near${intentsId ? `, Intents via ${intentsId}${NEAR.network === 'mainnet' ? '' : ' (unverified: no testnet Intents)'}` : ' only (Intents disabled, no --intents)'}`);
console.log(`policy       cap ${policy.daily_cap} / 24 h, per payment ${policy.max_per_payment}, batch ${policy.batch_size}, float ${near(BigInt(policy.min_near_float))}`);
console.log(`answer time  a lure counts as Ignored only if delivered at least ${Number(BigInt(policy.min_answer ?? '0') / 1_000_000_000n)} s before its ${Number(BigInt(policy.test_ttl) / 1_000_000_000n)} s expiry`);
console.log(`agent key    ${(policy.key_nonces ?? 0) > 0 ? `gas key, ${policy.key_nonces} nonce lanes, funded with ${near(BigInt(policy.key_allowance))} per arming (gas never leaves the vault balance)` : `classic function-call key, allowance ${near(BigInt(policy.key_allowance))} paid by the vault`}`);
if (problems.length) {
  problems.forEach((p) => console.error(`REFUSED: ${p}`));
  process.exit(1);
}
if (!send) {
  console.log('\ndry run: nothing signed. Add --send to create the vault.');
  process.exit(0);
}

const owner = new Account(ownerId, provider, loadLegacyKey(NEAR.network, ownerId) as KeyPairString);
const txs = await createVault({ parent: owner, provider, vaultId, code, init: { owner_id: ownerId, vendor_id: vendorId, token_id: tokenId, intents_id: intentsId, policy }, fund });
txs.forEach((t) => console.log(`tx           ${txUrl(t)}`));
const reg = await owner.callFunctionRaw({ contractId: tokenId, methodName: 'storage_deposit', args: { account_id: vaultId, registration_only: true }, deposit: BigInt(policy.storage_deposit), gas: teraToGas(30), waitUntil: 'FINAL' });
console.log(`token reg    ${txUrl(reg.transaction.hash)}`);

const v = await inspectVault(provider, vaultId);
const ok = v.codeHash === codeHashB58(code) && v.keys === 0 && v.status.owner_id === ownerId && v.status.vendor_id === vendorId && v.status.token_id === tokenId;
console.log(`\nverify       code hash ${v.codeHash} (${v.global ? 'global' : 'own code'}), ${v.keys} access keys, ${v.storage} B stored, version ${v.status.version}, mode ${v.status.mode}`);
console.log(ok ? 'OK: vault matches the plan' : 'MISMATCH: vault does not match the plan');
console.log('next: fund it with the token, add the tester FC key (commit_batch, reveal, release, prove_delivery) on the owner, owner propose_key, vendor accept_key');
process.exit(ok ? 0 : 1);
