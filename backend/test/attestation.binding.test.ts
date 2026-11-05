import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Wallet } from 'ethers';
import { expectedSignedText, type AiReceiptBytes } from '../src/lib/proof/receipt.ts';
import { verifyReceiptAgainstAttestation, type StoredAttestation } from '../src/lib/proof/attestation.ts';
import { receiptView } from '../src/lib/evidence.ts';

// Offline part only: quote, measurements and GPU evidence need Intel PCCS and NVIDIA NRAS (reverifyStoredAttestation).
const MODEL = 'z-ai/glm-5.3-flash';
const bodies = { requestBody: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }), responseBody: '{"id":"chatcmpl-1","choices":[]}' };

const report = (signingAlgo: 'ecdsa' | 'ed25519', signingAddress: string) => ({
  nonce: 'ab'.repeat(32),
  signer: { signingAlgo, signingAddress },
  intelQuote: '00',
  eventLog: [],
  appCompose: '{}',
});

const stored = (kind: 'model' | 'gateway', signingAlgo: 'ecdsa' | 'ed25519', signingAddress: string, reportSigner = signingAddress): StoredAttestation => {
  const common = {
    signer: { signingAlgo, signingAddress },
    tcbStatus: 'UpToDate' as const,
    advisoryIds: [],
    deploymentProvenance: 'not_checked' as const,
    runtimeMeasurements: {},
    verifiedAt: '2026-11-06T00:00:00.000Z',
  };
  return kind === 'model'
    ? { ...common, kind, report: report(signingAlgo, reportSigner), gpuEvidence: 'not_provided' }
    : { ...common, kind, report: { ...report(signingAlgo, reportSigner), reportedQuoteData: '00' }, tlsSpkiFingerprint: null };
};

const ecdsaReceipt = async (kind: AiReceiptBytes['signatureKind']) => {
  const w = Wallet.createRandom();
  const b = { responseId: 'chatcmpl-1', model: MODEL, signatureKind: kind, signingAlgo: 'ecdsa', signingAddress: w.address, ...bodies };
  const signedText = expectedSignedText(b);
  return { receipt: { ...b, signedText, signature: await w.signMessage(signedText) } as AiReceiptBytes, address: w.address };
};

describe('receipt signer against a stored attestation', () => {
  test('provider_tee receipt signed by the attested key binds', async () => {
    const { receipt, address } = await ecdsaReceipt('provider_tee');
    // the attestation side often omits 0x and uses lowercase; bytes must still match
    const res = verifyReceiptAgainstAttestation(receipt, stored('model', 'ecdsa', address.slice(2).toLowerCase()));
    expect(res.ok).toBe(true);
    expect(res.assurance).toBe('attested_signer');
    expect(res.scope).toMatch(/Offline/);
  });

  test('a receipt from any other key fails, even though the receipt itself verifies', async () => {
    const { receipt } = await ecdsaReceipt('provider_tee');
    const res = verifyReceiptAgainstAttestation(receipt, stored('model', 'ecdsa', Wallet.createRandom().address));
    expect(res.receipt.ok).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.signerIsAttested).toBe(false);
  });

  test('stored conclusion that disagrees with the raw report fails', async () => {
    const { receipt, address } = await ecdsaReceipt('provider_tee');
    expect(verifyReceiptAgainstAttestation(receipt, stored('model', 'ecdsa', address, Wallet.createRandom().address)).ok).toBe(false);
  });

  test('gateway receipt binds to a gateway report and stays partial', async () => {
    const { receipt, address } = await ecdsaReceipt('gateway');
    const res = verifyReceiptAgainstAttestation(receipt, stored('gateway', 'ecdsa', address));
    expect(res.ok).toBe(true);
    expect(res.assurance).toBe('partial');
    expect(verifyReceiptAgainstAttestation(receipt, stored('model', 'ecdsa', address)).kindMatches).toBe(false);
  });

  test('the SDK re-derives the model from the request bytes', async () => {
    const w = Wallet.createRandom();
    // signed text claims another model than the request body names
    const b = { responseId: 'x', model: 'other/model', signatureKind: 'provider_tee' as const, signingAlgo: 'ecdsa', signingAddress: w.address, ...bodies };
    const signedText = expectedSignedText(b);
    const res = verifyReceiptAgainstAttestation({ ...b, signedText, signature: await w.signMessage(signedText) }, stored('model', 'ecdsa', w.address));
    expect(res.receipt.ok).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/payload_mismatch/);
  });

  test('ed25519 receipt binds to its attested public key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pk = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
    const b = { responseId: 'e', model: MODEL, signatureKind: 'provider_tee' as const, signingAlgo: 'ed25519', signingAddress: pk, ...bodies };
    const signedText = expectedSignedText(b);
    const receipt = { ...b, signedText, signature: sign(null, Buffer.from(signedText, 'utf8'), privateKey).toString('hex') };
    expect(verifyReceiptAgainstAttestation(receipt, stored('model', 'ed25519', '0x' + pk)).ok).toBe(true);
    expect(verifyReceiptAgainstAttestation(receipt, stored('model', 'ecdsa', Wallet.createRandom().address)).ok).toBe(false);
  });
});

describe('public slot receipt view', () => {
  const createdAt = new Date('2026-11-12T00:00:00Z');

  test('a bound attestation reads attested_signer and the raw report is left out', async () => {
    const { receipt, address } = await ecdsaReceipt('provider_tee');
    const v = receiptView({ ...receipt, attestation: stored('model', 'ecdsa', address), createdAt });
    expect(v.assurance).toBe('attested_signer');
    expect(v.attestation).toMatchObject({ kind: 'model', bound: true, tcbStatus: 'UpToDate', gpuEvidence: 'not_provided' });
    expect(JSON.stringify(v)).not.toContain('intelQuote');
  });

  test('another key or no attestation stays signer_consistency', async () => {
    const { receipt } = await ecdsaReceipt('provider_tee');
    const other = receiptView({ ...receipt, attestation: stored('model', 'ecdsa', Wallet.createRandom().address), createdAt });
    expect(other.assurance).toBe('signer_consistency');
    expect(other.attestation?.bound).toBe(false);
    const none = receiptView({ ...receipt, attestation: null, createdAt });
    expect(none.assurance).toBe('signer_consistency');
    expect(none.attestation).toBeNull();
  });
});
