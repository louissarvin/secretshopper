import { createHmac, createPrivateKey, createPublicKey } from 'node:crypto';
import { KeyPair, type KeyPairString } from 'near-api-js';
import { base58 } from '@scure/base';

// ADR-2 (v2/37): one tester key per vault, derived from TESTER_KEY_SEED. NEAR keeps one access key per public key per
// account and an FC key has one receiver, so one owner with two vaults needs two keys. Nothing is stored.

export const KEY_LABEL = 'secret-shopper/tester-key/v1';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The 32-byte ed25519 seed for this network and vault: HMAC-SHA256(seed, `${KEY_LABEL}/${network}/${vaultId}`). */
export const testerSeedFor = (seed: Buffer, network: string, vaultId: string): Buffer =>
  createHmac('sha256', seed).update(`${KEY_LABEL}/${network}/${vaultId}`).digest();

/** The vault's tester key pair, as near-api-js signs with it. */
export const testerKeyFor = (seed: Buffer, network: string, vaultId: string): KeyPair => {
  const seed32 = testerSeedFor(seed, network, vaultId);
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32]), format: 'der', type: 'pkcs8' });
  const pub = Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x!, 'base64url');
  return KeyPair.fromString(`ed25519:${base58.encode(Buffer.concat([seed32, pub]))}` as KeyPairString);
};

/** Public key of a configured private key string (the default vault's TESTER_PRIVATE_KEY). */
export const publicKeyOf = (privateKey: string): string => KeyPair.fromString(privateKey as KeyPairString).getPublicKey().toString();
