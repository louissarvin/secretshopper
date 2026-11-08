import { createHash } from 'node:crypto';
import { Account, KeyPair, actions, baseEncode, teraToGas, type JsonRpcProvider } from 'near-api-js';
import { checkPolicy, minFunding, type Code, type VaultInit } from '../../backend/src/lib/vault/policy.ts';

export { checkIntents, checkPolicy, gasKeyCost, MAINNET_INTENTS_ID, minFunding } from '../../backend/src/lib/vault/policy.ts';
export type { Code, Policy, VaultInit } from '../../backend/src/lib/vault/policy.ts';

export const codeHashOf = (wasm: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(wasm).digest());
export const codeHashB58 = (c: Code): string => baseEncode(c.kind === 'global' ? c.codeHash : codeHashOf(c.wasm));

/**
 * Creates and initializes a vault. Global: one tx from the parent (owner) creates the account, funds it, attaches
 * the code by hash and calls `new`, so the vault never holds a key. Classic: the parent creates the account with a
 * one-time key, then that key deploys, inits and deletes itself in one tx. Returns the tx hashes.
 */
export const createVault = async (o: { parent: Account; provider: JsonRpcProvider; vaultId: string; code: Code; init: VaultInit; fund: bigint }): Promise<string[]> => {
  if (!o.vaultId.endsWith(`.${o.parent.accountId}`) || o.vaultId.slice(0, -o.parent.accountId.length - 1).includes('.'))
    throw new Error(`${o.vaultId} must be a direct sub-account of ${o.parent.accountId}`);
  const errs = checkPolicy(o.init.policy);
  if (errs.length) throw new Error(`bad policy: ${errs.join('; ')}`);
  if (o.fund < minFunding(o.code, o.init.policy)) throw new Error(`fund at least ${minFunding(o.code, o.init.policy)} yocto`);
  const initCall = actions.functionCall('new', o.init as unknown as Record<string, unknown>, teraToGas(50), 0n);
  if (o.code.kind === 'global') {
    const out = await o.parent.signAndSendTransaction({
      receiverId: o.vaultId,
      actions: [actions.createAccount(), actions.transfer(o.fund), actions.useGlobalContract({ codeHash: o.code.codeHash }), initCall],
      waitUntil: 'FINAL',
    });
    return [out.transaction.hash];
  }
  const kp = KeyPair.fromRandom('ed25519');
  const created = await o.parent.createAccount({ newAccountId: o.vaultId, publicKey: kp.getPublicKey(), nearToTransfer: o.fund });
  const vault = new Account(o.vaultId, o.provider, kp.toString());
  const out = await vault.signAndSendTransaction({
    receiverId: o.vaultId,
    actions: [actions.deployContract(o.code.wasm), initCall, actions.deleteKey(kp.getPublicKey())],
    waitUntil: 'FINAL',
  });
  return [created.transaction.hash, out.transaction.hash];
};

/** What a verifier checks after deploy: code hash, no keys, and the vault's own view of its owner and version. */
export const inspectVault = async (provider: JsonRpcProvider, vaultId: string) => {
  const acct = await provider.viewAccount({ accountId: vaultId });
  const keys = (await provider.viewAccessKeyList({ accountId: vaultId, finalityQuery: { finality: 'final' } })).keys;
  const status = (await provider.callFunction({ contractId: vaultId, method: 'get_status', args: {} })) as { owner_id: string; vendor_id: string; token_id: string; version: string; mode: string };
  return { codeHash: acct.global_contract_hash ?? acct.code_hash, global: !!acct.global_contract_hash, storage: acct.storage_usage, keys: keys.length, status };
};

/** True if a global contract with this code hash is published on the network. */
export const globalCodePublished = (provider: JsonRpcProvider, codeHash: string): Promise<boolean> =>
  provider.viewGlobalContractCode({ identifier: { codeHash } }).then(
    () => true,
    () => false
  );
