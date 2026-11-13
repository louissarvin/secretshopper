import { describe, expect, test } from 'bun:test';
import { createPublicKey, verify } from 'node:crypto';
import { KeyPair, type KeyPairString } from 'near-api-js';
import { base58 } from '@scure/base';
import { KEY_LABEL, publicKeyOf, testerKeyFor, testerSeedFor } from '../src/tester/keys.ts';

// Multi-vault: per-vault tester keys from one seed. The vector pins the derivation: changing it orphans every
// key an owner has added, so a change must come with a new label (v2) and a re-add by each owner.
const SEED = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');
const VAULT = 'selfserve-e2e.ss-owner-e9c3db.testnet';

describe('tester keys', () => {
  test('a fixed seed, network and vault give a fixed key', () => {
    expect(KEY_LABEL).toBe('secret-shopper/tester-key/v1');
    // both values checked independently: Python hmac for the seed, OpenSSL for the ed25519 public key
    expect(testerSeedFor(SEED, 'testnet', VAULT).toString('hex')).toBe('00e20bd8c11992ee03bc12d65e970d76b111acf98b15e95b3ab88223fb0f181a');
    expect(testerKeyFor(SEED, 'testnet', VAULT).getPublicKey().toString()).toBe(VECTOR);
  });

  test('another vault or network gives another key; the same inputs give the same key', () => {
    const a = testerKeyFor(SEED, 'testnet', VAULT).getPublicKey().toString();
    expect(testerKeyFor(SEED, 'testnet', VAULT).getPublicKey().toString()).toBe(a);
    expect(testerKeyFor(SEED, 'testnet', 'shop4.ss-owner-e9c3db.testnet').getPublicKey().toString()).not.toBe(a);
    expect(testerKeyFor(SEED, 'mainnet', VAULT).getPublicKey().toString()).not.toBe(a);
    expect(testerKeyFor(Buffer.alloc(32, 1), 'testnet', VAULT).getPublicKey().toString()).not.toBe(a);
  });

  test('signatures verify against the public key, with near-api-js and with node:crypto', () => {
    const kp = testerKeyFor(SEED, 'testnet', VAULT);
    const msg = new TextEncoder().encode('commit_batch');
    const { signature } = kp.sign(msg);
    expect(kp.verify(msg, signature)).toBe(true);
    const raw = base58.decode(kp.getPublicKey().toString().slice('ed25519:'.length));
    const spki = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    expect(verify(null, msg, spki, signature)).toBe(true);
    expect(verify(null, new TextEncoder().encode('reveal'), spki, signature)).toBe(false);
  });

  test('the key string the signer gets round-trips, and publicKeyOf reads a configured key', () => {
    const kp = testerKeyFor(SEED, 'testnet', VAULT);
    const again = KeyPair.fromString(kp.toString() as KeyPairString);
    expect(again.getPublicKey().toString()).toBe(kp.getPublicKey().toString());
    expect(publicKeyOf(kp.toString())).toBe(kp.getPublicKey().toString());
  });
});

const VECTOR = 'ed25519:JEEsXX3QGjVUaPkH5XzYe3zotx9DauUNNzNcXrSKhGNE';
