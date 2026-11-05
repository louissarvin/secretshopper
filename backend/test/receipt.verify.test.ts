import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { checkReceipt, expectedSignedText, type AiReceiptBytes } from '../src/tester/receipt.ts';
import { verifyReceiptAgainstAttestation, type StoredAttestation } from '../src/lib/proof/attestation.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'receipt-k3.json');

const base = (kind: AiReceiptBytes['signatureKind']) => ({
  responseId: 'chatcmpl-local',
  model: 'Qwen/Qwen3.8-27B',
  signatureKind: kind,
  requestBody: '{"model":"Qwen/Qwen3.8-27B","messages":[]}',
  responseBody: '{"id":"chatcmpl-local","choices":[]}',
});

// Locally signed with a random key: exercises the byte and signature checks, not NEAR AI itself.
const localReceipt = async (kind: AiReceiptBytes['signatureKind']): Promise<AiReceiptBytes> => {
  const wallet = Wallet.createRandom();
  const b = { ...base(kind), signingAlgo: 'ecdsa', signingAddress: wallet.address };
  const signedText = expectedSignedText(b);
  return { ...b, signedText, signature: await wallet.signMessage(signedText) };
};

// ed25519 per the docs: the signature covers the UTF-8 text, signing_address is the 32-byte public key in hex.
const ed25519Receipt = (kind: AiReceiptBytes['signatureKind']): AiReceiptBytes => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const b = { ...base(kind), signingAlgo: 'ed25519', signingAddress: raw.toString('hex') };
  const signedText = expectedSignedText(b);
  return { ...b, signedText, signature: sign(null, Buffer.from(signedText, 'utf8'), privateKey).toString('hex') };
};

const strip0x = (s: string) => s.replace(/^0x/i, '');

describe('receipt check logic', () => {
  test('provider_tee and gateway formats verify', async () => {
    expect(checkReceipt(await localReceipt('provider_tee')).ok).toBe(true);
    expect(checkReceipt(await localReceipt('gateway')).ok).toBe(true);
  });

  test('signatures and addresses verify with or without 0x and in any hex case', async () => {
    const r = await localReceipt('provider_tee');
    expect(checkReceipt({ ...r, signature: strip0x(r.signature) }).ok).toBe(true);
    expect(checkReceipt({ ...r, signingAddress: strip0x(r.signingAddress) }).ok).toBe(true);
    expect(checkReceipt({ ...r, signingAddress: '0X' + strip0x(r.signingAddress).toUpperCase(), signature: r.signature.toUpperCase().replace('0X', '0x') }).ok).toBe(true);
  });

  test('wrong lengths and non-hex are rejected before any crypto', async () => {
    const r = await localReceipt('gateway');
    expect(checkReceipt({ ...r, signature: r.signature.slice(0, -2) }).error).toMatch(/65 bytes/);
    expect(checkReceipt({ ...r, signingAddress: r.signingAddress + '00' }).error).toMatch(/20 bytes/);
    expect(checkReceipt({ ...r, signature: r.signature.replace(/.$/, 'g') }).ok).toBe(false);
    expect(checkReceipt({ ...r, signingAlgo: 'rsa' }).error).toMatch(/unsupported/);
  });

  test('ed25519 receipts verify; a flipped text byte or another key fails', () => {
    const r = ed25519Receipt('provider_tee');
    expect(checkReceipt(r).ok).toBe(true);
    expect(checkReceipt({ ...r, signingAddress: '0x' + r.signingAddress }).ok).toBe(true);
    expect(checkReceipt({ ...r, signedText: r.signedText.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }).ok).toBe(false);
    expect(checkReceipt({ ...r, signingAddress: ed25519Receipt('provider_tee').signingAddress }).signerMatches).toBe(false);
    expect(checkReceipt({ ...r, signature: r.signature.slice(2) }).error).toMatch(/64 bytes/);
  });

  test('one changed response byte fails', async () => {
    const r = await localReceipt('provider_tee');
    const res = checkReceipt({ ...r, responseBody: r.responseBody.replace('[]', '[ ]') });
    expect(res.textMatches).toBe(false);
    expect(res.ok).toBe(false);
  });

  test('wrong signer address fails', async () => {
    const r = await localReceipt('gateway');
    expect(checkReceipt({ ...r, signingAddress: Wallet.createRandom().address }).signerMatches).toBe(false);
  });

  test('the result states its scope: gateway is partial, provider_tee alone is signer consistency only', async () => {
    const g = checkReceipt(await localReceipt('gateway'));
    const m = checkReceipt(await localReceipt('provider_tee'));
    expect(g.assurance).toBe('partial');
    expect(m.assurance).toBe('signer_consistency');
    expect(m.scope).toMatch(/byte integrity and signer consistency only/);
  });
});

describe.skipIf(!existsSync(FIXTURE))('real K3 receipt (test/fixtures/receipt-k3.json)', () => {
  test('stored bytes match signedText and the signature recovers the signer', () => {
    const r = JSON.parse(readFileSync(FIXTURE, 'utf8')) as AiReceiptBytes & { attestation?: StoredAttestation };
    const res = checkReceipt(r);
    expect(res.textMatches).toBe(true);
    expect(res.signerMatches).toBe(true);
    if (r.attestation) expect(verifyReceiptAgainstAttestation(r, r.attestation).ok).toBe(true);
  });
});
