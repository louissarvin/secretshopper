import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { seal, unseal } from '../src/tester/seal.ts';

const key = randomBytes(32);
const secret = { salt: 'ab'.repeat(32), payee: 'f'.repeat(64), payeeSecret: 'ed25519:xyz', invoiceId: 'cd'.repeat(32) };

const flip = (b64: string, at: number): string => {
  const buf = Buffer.from(b64, 'base64');
  buf[at] ^= 0x01;
  return buf.toString('base64');
};

describe('seal (AES-256-GCM)', () => {
  test('round trip', () => expect(unseal<typeof secret>(key, seal(key, secret))).toEqual(secret));

  test('fresh IV every time', () => expect(seal(key, secret)).not.toBe(seal(key, secret)));

  test('tampered ciphertext, tag or iv throws', () => {
    const blob = seal(key, secret);
    expect(() => unseal(key, flip(blob, 40))).toThrow(); // ciphertext
    expect(() => unseal(key, flip(blob, 15))).toThrow(); // tag
    expect(() => unseal(key, flip(blob, 3))).toThrow(); // iv
  });

  test('wrong key throws', () => expect(() => unseal(randomBytes(32), seal(key, secret))).toThrow());

  test('rejects keys that are not 32 bytes and truncated blobs', () => {
    expect(() => seal(randomBytes(16), secret)).toThrow();
    expect(() => unseal(key, Buffer.alloc(20).toString('base64'))).toThrow();
  });
});
