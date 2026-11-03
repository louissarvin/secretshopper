import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { hexlify, verifyMessage } from 'ethers';

// Independent check anyone can repeat from the stored bytes (docs.near.ai cloud/verification/reference/response-signature-verification).

export interface AiReceiptBytes {
  responseId: string;
  model: string;
  signatureKind: 'provider_tee' | 'gateway';
  signingAlgo: string;
  signingAddress: string;
  signedText: string;
  signature: string;
  requestBody: string; // exact bytes sent
  responseBody: string; // exact bytes received
}

/**
 * What a receipt can prove on its own. `signer_consistency`: bytes and signature agree with the stored signer, but
 * nothing here ties that key to a TEE. `partial`: a Gateway signature, which never proves the model ran in a TEE.
 * `attested_signer`: the signer also equals the key in a model attestation (see attestation.ts).
 */
export type ReceiptAssurance = 'attested_signer' | 'signer_consistency' | 'partial';

export const RECEIPT_SCOPE =
  'Proves byte integrity and signer consistency only: the signed text matches sha256 of the exact request and response bytes and the signature verifies against signing_address. Binding that key to a TEE needs the attestation report.';

export const assuranceOf = (kind: AiReceiptBytes['signatureKind'], signerAttested: boolean): ReceiptAssurance =>
  kind === 'gateway' ? 'partial' : signerAttested ? 'attested_signer' : 'signer_consistency';

export const assuranceNote = (a: ReceiptAssurance): string =>
  a === 'partial'
    ? 'partial: Gateway signature; proves the Gateway saw these bytes, not that the model ran in a TEE'
    : a === 'attested_signer'
      ? 'signer matches the key bound in the stored model attestation'
      : 'signer consistent with the receipt; not bound to a TEE without the model attestation';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** provider_tee: "<model>:<sha(req)>:<sha(resp)>", gateway: "<sha(req)>:<sha(resp)>". */
export const expectedSignedText = (r: Pick<AiReceiptBytes, 'signatureKind' | 'model' | 'requestBody' | 'responseBody'>): string =>
  r.signatureKind === 'provider_tee'
    ? `${r.model}:${sha(r.requestBody)}:${sha(r.responseBody)}`
    : `${sha(r.requestBody)}:${sha(r.responseBody)}`;

/** Hex with an optional 0x/0X prefix, decoded to exactly `bytes` bytes; null otherwise. */
export const hexBytes = (value: unknown, bytes: number): Buffer | null => {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/^0x/i, '');
  if (hex.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex');
};

const sameBytes = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

// Ed25519 SPKI DER prefix (RFC 8410) for a raw 32-byte public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Signer key length per algorithm, in bytes: ecdsa address 20, ed25519 public key 32. */
export const SIGNER_BYTES: Record<string, number> = { ecdsa: 20, ed25519: 32 };
const SIGNATURE_BYTES: Record<string, number> = { ecdsa: 65, ed25519: 64 };

export interface ReceiptCheck {
  ok: boolean;
  textMatches: boolean;
  signerMatches: boolean;
  recovered: string | null; // ecdsa only: the recovered address, lowercase 0x hex
  error?: string;
  assurance: ReceiptAssurance; // what ok=true would mean; never attested_signer from this check alone
  scope: string;
}

/** Verifies text and signature against the receipt's own signer. ecdsa is EIP-191; ed25519 signs the UTF-8 text. */
export const checkReceipt = (r: AiReceiptBytes): ReceiptCheck => {
  const textMatches = r.signedText === expectedSignedText(r);
  const base = { textMatches, recovered: null as string | null, assurance: assuranceOf(r.signatureKind, false), scope: RECEIPT_SCOPE };
  const fail = (error: string, recovered: string | null = null): ReceiptCheck => ({ ...base, ok: false, signerMatches: false, recovered, error });

  const algo = r.signingAlgo;
  if (!(algo in SIGNER_BYTES)) return fail(`unsupported signing_algo ${String(algo).slice(0, 20)}`);
  const signer = hexBytes(r.signingAddress, SIGNER_BYTES[algo]);
  if (!signer) return fail(`signing_address must be ${SIGNER_BYTES[algo]} bytes of hex`);
  const sig = hexBytes(r.signature, SIGNATURE_BYTES[algo]);
  if (!sig) return fail(`signature must be ${SIGNATURE_BYTES[algo]} bytes of hex`);

  let signerMatches = false;
  let recovered: string | null = null;
  try {
    if (algo === 'ecdsa') {
      recovered = verifyMessage(r.signedText, hexlify(sig)).toLowerCase();
      signerMatches = sameBytes(Buffer.from(recovered.slice(2), 'hex'), signer);
    } else {
      const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, signer]), format: 'der', type: 'spki' });
      signerMatches = cryptoVerify(null, Buffer.from(r.signedText, 'utf8'), key, sig);
    }
  } catch (e) {
    return fail(`signature does not verify: ${(e as Error).message.slice(0, 120)}`, recovered);
  }
  return { ...base, ok: textMatches && signerMatches, signerMatches, recovered, ...(signerMatches ? {} : { error: 'signature does not match signing_address' }) };
};
