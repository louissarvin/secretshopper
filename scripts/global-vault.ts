/**
 * `bun global-vault.ts`: measures the vault deployed the classic way against one that uses the vault code as a
 * NEP-591 global contract by hash, on a local sandbox. The global vault is created, given code and initialized by
 * its parent (the owner) in one transaction, so it never holds a full-access key. Exit 0 only if every check holds.
 * Needs contracts/shop/target/near/secret_shopper.wasm. Env: DEMO_SANDBOX_VERSION (default 2.14.0).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { createVault, globalCodePublished, inspectVault, minFunding, type VaultInit } from './lib/vault-deploy.ts';
import { tearDownSandbox } from './lib/sandbox.ts';

const WASM = readFileSync(join(resolve(import.meta.dir, '..'), 'contracts/shop/target/near/secret_shopper.wasm'));
const digest = new Uint8Array(createHash('sha256').update(WASM).digest());
const codeHash = baseEncode(digest);
const NEAR = 10n ** 24n;
const BYTE = 10n ** 19n; // storage staking, yocto per byte
const fmt = (y: bigint) => `${(Number(y) / 1e24).toFixed(4)} NEAR`;

const fails: string[] = [];
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails.push(what);
};

const sandbox = await Sandbox.start({ version: process.env.DEMO_SANDBOX_VERSION || '2.14.0' });
Object.assign(process.env, { NEAR_NETWORK: 'testnet', NEAR_RPC_URL: sandbox.rpcUrl }); // chainread reads its RPC at import
const { attestVault } = await import('./lib/chainread.ts');
try {
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
  const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);
  const newAccount = async (id: string, near: bigint) => {
    const kp = KeyPair.fromRandom('ed25519');
    await root.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: near * NEAR });
    return { acct: new Account(id, provider, kp.toString()), kp };
  };
  const ownerId = `owner.${DEFAULT_ACCOUNT_ID}`;
  const init = (vendor = `vendor.${DEFAULT_ACCOUNT_ID}`): VaultInit => ({
    owner_id: ownerId,
    vendor_id: vendor,
    token_id: `usdc.${DEFAULT_ACCOUNT_ID}`,
    intents_id: null,
    policy: {
      daily_cap: '5000000', max_per_payment: '2000000', max_new_payees_per_day: 3, max_payments_per_day: 20, max_decisions_per_day: 50,
      batch_size: 3, batch_interval: '1', test_ttl: '86400000000000', min_answer: '21600000000000', reveal_grace: '3600000000000', rearm_cooldown: '3600000000000',
      payee_delay: '0', limits_delay: '3600000000000', key_allowance: nearToYocto('0.25').toString(),
      storage_deposit: '1250000000000000000000', min_near_float: nearToYocto('0.5').toString(),
    },
  });

  console.log(`vault wasm ${WASM.length} B, code hash ${codeHash}`);

  // 1. Publish once by hash: immutable, burnt (not locked) at 10x the storage rate.
  const hub = await newAccount(`codehub.${DEFAULT_ACCOUNT_ID}`, 100n);
  const hubBefore = await balance(hub.acct.accountId);
  await hub.acct.signAndSendTransaction({ receiverId: hub.acct.accountId, actions: [actions.deployGlobalContract(new Uint8Array(WASM), 'codeHash')], waitUntil: 'FINAL' });
  const publishCost = hubBefore - (await balance(hub.acct.accountId));
  console.log(`publish by hash: ${fmt(publishCost)} burnt (gas included), one time for every vault`);
  expect(publishCost >= BigInt(WASM.length) * BYTE * 10n, 'publishing costs 10x the per-byte storage rate');
  expect(await globalCodePublished(provider, codeHash), 'the published code is found by hash (create-vault preflight)');
  expect(!(await globalCodePublished(provider, baseEncode(new Uint8Array(32)))), 'an unpublished hash is not found');

  const owner = await newAccount(ownerId, 50n);

  // 2. Classic vault through scripts/lib/vault-deploy.ts: a one-time key deploys, inits and deletes itself in one tx.
  const classicId = `classic.${ownerId}`;
  const classicCode = { kind: 'classic' as const, wasm: new Uint8Array(WASM) };
  const [classicCreate] = await createVault({ parent: owner.acct, provider, vaultId: classicId, code: classicCode, init: init(), fund: minFunding(classicCode, init().policy) });
  const c = await provider.viewAccount({ accountId: classicId });
  const ci = await inspectVault(provider, classicId);
  expect(ci.keys === 0 && ci.codeHash === codeHash && !ci.global, 'classic vault: own code, one-time key already deleted');

  // 3. Global vault: the owner creates it, attaches the code by hash and inits it in one tx. No key is ever added.
  const globalId = `vault.${ownerId}`;
  const globalCode = { kind: 'global' as const, codeHash: digest };
  const fund = minFunding(globalCode, init().policy); // float 0.5 + state + 0.1 headroom
  const ownerBefore = await balance(ownerId);
  const [txHash] = await createVault({ parent: owner.acct, provider, vaultId: globalId, code: globalCode, init: init(), fund });
  const att = await attestVault(globalId, { hash: txHash, signer: ownerId });
  expect(att.ok && att.codeHash === codeHash && att.init?.owner_id === ownerId, `verify-evidence provenance attests the atomic global vault${att.ok ? '' : `: ${att.reasons.join('; ')}`}`);
  const classicAtt = await attestVault(classicId, { hash: classicCreate, signer: ownerId });
  expect(!classicAtt.ok, `a classic vault is not attested (${classicAtt.reasons[0]})`);
  const ownerSpent = ownerBefore - (await balance(ownerId));
  const g = await provider.viewAccount({ accountId: globalId });
  const keys = (await provider.viewAccessKeyList({ accountId: globalId, finalityQuery: { finality: 'final' } })).keys;
  const status = (await provider.callFunction({ contractId: globalId, method: 'get_status', args: {} })) as { version: string; owner_id: string };

  console.log(`classic vault: storage ${c.storage_usage} B, ${fmt(BigInt(c.storage_usage) * BYTE)} locked`);
  console.log(`global vault:  storage ${g.storage_usage} B, ${fmt(BigInt(g.storage_usage) * BYTE)} locked; owner spent ${fmt(ownerSpent)} including the ${fmt(fund)} it funded; tx ${txHash}`);
  expect(g.global_contract_hash === codeHash, 'view_account shows the global code hash, so anyone can check which code a vault runs');
  expect(keys.length === 0, 'the global vault has no access key at all, it never had one');
  expect(status.owner_id === ownerId && /^2\./.test(status.version), `vault answers get_status (version ${status.version})`);
  expect(g.storage_usage * 20 < c.storage_usage, 'global vault stores under 5% of the classic bytes');
  const breakEven = Number(publishCost / ((BigInt(c.storage_usage - g.storage_usage)) * BYTE)) + 1;
  console.log(`break-even: the one-time publish pays for itself from vault #${breakEven}`);

  // 4. Init access: a stranger cannot initialize a code-attached vault; its parent can.
  const pendingId = `pending.${ownerId}`;
  const pendingTx = await owner.acct.signAndSendTransaction({
    receiverId: pendingId,
    actions: [actions.createAccount(), actions.transfer(fund), actions.useGlobalContract({ codeHash: digest })],
    waitUntil: 'FINAL',
  });
  const stranger = await newAccount(`stranger.${DEFAULT_ACCOUNT_ID}`, 5n);
  const strangerInit = await stranger.acct
    .callFunctionRaw({ contractId: pendingId, methodName: 'new', args: init(stranger.acct.accountId), gas: teraToGas(50), deposit: 0n, waitUntil: 'FINAL' })
    .then(() => 'ok', (e: Error) => e.message);
  expect(/only the vault or its parent/.test(strangerInit), 'a stranger cannot initialize a vault it does not parent');
  const parentInit = await owner.acct
    .callFunctionRaw({ contractId: pendingId, methodName: 'new', args: init(), gas: teraToGas(50), deposit: 0n, waitUntil: 'FINAL' })
    .then(() => 'ok', (e: Error) => e.message);
  expect(parentInit === 'ok', 'the parent account can initialize it');
  const again = await owner.acct
    .callFunctionRaw({ contractId: pendingId, methodName: 'new', args: init(), gas: teraToGas(50), deposit: 0n, waitUntil: 'FINAL' })
    .then(() => 'ok', (e: Error) => e.message);
  expect(again !== 'ok', 'a second init is refused');
  const pendingAtt = await attestVault(pendingId, { hash: pendingTx.transaction.hash, signer: ownerId });
  expect(!pendingAtt.ok, `code attached in one tx and initialized in another is not attested (${pendingAtt.reasons[0]})`);
  const forged = await attestVault(`0s${'ab'.repeat(20)}`);
  expect(!forged.ok, 'a NEP-616 deterministic (0s) account is never attested');
} finally {
  await tearDownSandbox(sandbox);
}
console.log(fails.length ? `\n${fails.length} check(s) FAILED` : '\nPASS: global vault checks held');
process.exit(fails.length ? 1 : 0);
