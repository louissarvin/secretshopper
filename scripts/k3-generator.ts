/**
 * K3: one test generation through NEAR AI Cloud with a verified receipt.
 * Writes backend/test/fixtures/receipt-k3.json, which backend/test/receipt.verify.test.ts re-checks offline.
 * Needs Bun >= 1.4.4 (the SDK's Node TLS binding fails on 1.3.1). Env: NEARAI_API_KEY_TESTER, GENERATOR_MODEL, GENERATOR_FALLBACK_MODELS.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyPair, keyToImplicitAddress } from 'near-api-js';
import { createVerifiedChat } from '../backend/src/tester/nearai.ts';
import { buildGeneratorInput, createGenerator } from '../backend/src/tester/generator.ts';
import { checkReceipt } from '../backend/src/tester/receipt.ts';
import { verifyReceiptAgainstAttestation } from '../backend/src/lib/proof/attestation.ts';
import { req } from './lib/net.ts';

const models = [process.env.GENERATOR_MODEL || 'Qwen/Qwen3.8-27B', ...(process.env.GENERATOR_FALLBACK_MODELS ?? 'Qwen/Qwen3.6-35B-A3B-FP8').split(',').filter(Boolean)];
const chat = createVerifiedChat({ apiKey: req('NEARAI_API_KEY_TESTER'), baseUrl: process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1' });
const generate = createGenerator(chat, models);

// A style sample in the shape the owner stores on a vendor record.
const sample = {
  number: 'INV-2026-0412',
  issued: '2026-10-02',
  due: '2026-11-01',
  bill_to: 'Larkspur Analytics Pte Ltd',
  lines: [{ description: 'Cloud hosting, October', qty: 1, unit_price: '0.80' }],
  total: '0.80',
  currency: 'USDC',
  pay_to: 'acme-hosting.testnet',
};

const payee = keyToImplicitAddress(KeyPair.fromRandom('ed25519').getPublicKey());
const { draft, receipt, attestation } = await generate(
  buildGeneratorInput({
    company: 'Larkspur Analytics Pte Ltd',
    category: 'bank_change',
    vendor: { legalName: 'Acme Hosting LLC', contactEmail: 'billing@acme-hosting.example', styleSet: [sample] },
    payee,
    amount: '0.80',
  })
);
const out = join(import.meta.dir, '..', 'backend', 'test', 'fixtures', 'receipt-k3.json');
// the attestation lets receipt.verify.test.ts check the signer is the attested key, offline
writeFileSync(out, JSON.stringify({ ...receipt, attestation }, null, 2) + '\n');
console.log(
  JSON.stringify({ signatureKind: receipt.signatureKind, signingAddress: receipt.signingAddress, bytesMatch: checkReceipt(receipt).ok, assurance: verifyReceiptAgainstAttestation(receipt, attestation).assurance, model: receipt.model, invoiceKeys: Object.keys(draft.invoice).sort(), fixture: out }, null, 2)
);
