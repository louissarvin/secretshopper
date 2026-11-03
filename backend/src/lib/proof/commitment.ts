import { createHash } from 'node:crypto';
import { HEX32_RE } from '../../utils/ids.ts';

// Public proof primitives: used by the tester, the evidence route and the standalone scripts.

/** Void slots and v1-style tests bind no receipt: 32 zero bytes. */
export const ZERO_RECEIPT = '0'.repeat(64);

/**
 * v2: sha256(salt32 || u8 len(payee) || payee utf8 || invoice_id32 || receipt32), lowercase hex.
 * Must byte-match commitment_of in contracts/shop/src/lib.rs; the contract only accepts lowercase hex.
 */
export const commitmentOf = (saltHex: string, payee: string, invoiceIdHex: string, receiptHashHex: string): string => {
  for (const [name, v] of [['salt', saltHex], ['invoice_id', invoiceIdHex], ['receipt_hash', receiptHashHex]] as const) {
    if (!HEX32_RE.test(v)) throw new Error(`${name} must be 64 lowercase hex chars`);
  }
  const p = Buffer.from(payee, 'utf8');
  if (p.length > 64) throw new Error('payee longer than 64 bytes');
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(saltHex, 'hex'), Buffer.from([p.length]), p, Buffer.from(invoiceIdHex, 'hex'), Buffer.from(receiptHashHex, 'hex')]))
    .digest('hex');
};

/** Receipt hash bound into a test's commitment: sha256 of the NEAR AI signed text. */
export const receiptHashOf = (signedText: string): string => createHash('sha256').update(signedText, 'utf8').digest('hex');

export const sha256Hex = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
