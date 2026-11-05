import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitmentOf, ZERO_RECEIPT } from '../src/lib/proof/commitment.ts';

// v2: sha256(salt32 || u8 len(payee) || payee || invoice32 || receipt32). Expected values come from the Rust unit
// test in contracts/shop (first two) and an independent Python hashlib computation (all four), not from this code.
const fill = (b: number) => Buffer.alloc(32, b).toString('hex');
const VECTORS = [
  { name: 'test', salt: fill(7), payee: 'f'.repeat(64), invoice_id: fill(5), receipt_hash: fill(9), commitment: '98d556b4762dbdff9feb072ea42ea21e7bf532a9755d19f5b54e40cf1f4dce35' },
  { name: 'void', salt: fill(8), payee: '', invoice_id: fill(0), receipt_hash: ZERO_RECEIPT, commitment: '7609884186c12579079791e90eb99b6488c796d168f4805e3cde1013de3f48bc' },
  { name: 'eth_implicit', salt: fill(1), payee: '0x' + 'ab'.repeat(20), invoice_id: fill(2), receipt_hash: fill(3), commitment: '5692fe5caddc1cc61587a5a68695b7cdb81a46b8a3aae5cd9e5c7fd224b53e9f' },
  { name: 'named_account', salt: fill(0xab), payee: 'alice.testnet', invoice_id: fill(0xcd), receipt_hash: fill(0xef), commitment: '6739ccf6cfeeef9223db9081d389a53b68b021e7e4b799f0bbd25036383fb1ff' },
];

describe('commitmentOf v2 parity with contracts/shop commitment_of', () => {
  for (const v of VECTORS) {
    test(v.name, () => expect(commitmentOf(v.salt, v.payee, v.invoice_id, v.receipt_hash)).toBe(v.commitment));
  }

  test('rejects uppercase hex like the contract does', () => {
    // 0xab has hex letters, so upper and lower case differ
    expect(() => commitmentOf(fill(0xab).toUpperCase(), '', fill(5), ZERO_RECEIPT)).toThrow();
    expect(() => commitmentOf(fill(7), '', fill(0xab).toUpperCase(), ZERO_RECEIPT)).toThrow();
    expect(() => commitmentOf(fill(7), '', fill(5), fill(0xab).toUpperCase())).toThrow();
  });

  test('rejects payee over 64 bytes and short hashes', () => {
    expect(() => commitmentOf(fill(7), 'a'.repeat(65), fill(5), ZERO_RECEIPT)).toThrow();
    expect(() => commitmentOf('07', '', fill(5), ZERO_RECEIPT)).toThrow();
    expect(() => commitmentOf(fill(7), '', fill(5), '00')).toThrow();
  });

  test('the receipt is bound: changing it changes the commitment', () => {
    const v = VECTORS[0];
    expect(commitmentOf(v.salt, v.payee, v.invoice_id, fill(10))).not.toBe(v.commitment);
  });

  test('emits test/fixtures/commitment.json for the Rust side', () => {
    const dir = join(import.meta.dir, 'fixtures');
    mkdirSync(dir, { recursive: true });
    const fixture = {
      description: 'v2: sha256(salt32 || u8 len(payee) || payee utf8 || invoice_id32 || receipt_hash32), lowercase hex. Checked by backend/test/commitment.parity.test.ts',
      vectors: VECTORS,
    };
    writeFileSync(join(dir, 'commitment.json'), JSON.stringify(fixture, null, 2) + '\n');
    expect(fixture.vectors.every((v) => commitmentOf(v.salt, v.payee, v.invoice_id, v.receipt_hash) === v.commitment)).toBe(true);
  });
});
