import {
  isVerificationError,
  verifyGatewayAttestation,
  verifyGatewayResponse,
  verifyModelAttestation,
  verifyModelResponse,
  type CompletionSignature,
  type GatewayAttestation,
  type ModelAttestation,
  type RuntimeMeasurements,
  type SigningIdentity,
  type TcbStatus,
  type VerifiedCompletionResult,
  type VerifiedGatewayAttestation,
  type VerifiedModelAttestation,
} from '@nearai/inference-sdk';
import { assuranceOf, checkReceipt, hexBytes, SIGNER_BYTES, type AiReceiptBytes, type ReceiptAssurance, type ReceiptCheck } from './receipt.ts';

/**
 * The attestation the SDK verified before a request, kept so anyone can re-check the receipt's signer later.
 * `report` is the raw evidence (quote, event log, nonce, GPU payload); the other fields are the SDK's conclusions.
 */
export type StoredAttestation = {
  kind: 'model' | 'gateway';
  signer: SigningIdentity;
  tcbStatus: TcbStatus;
  advisoryIds: string[];
  deploymentProvenance: 'not_checked' | 'verified';
  runtimeMeasurements: RuntimeMeasurements;
  verifiedAt: string; // ISO time of our verification, not of the quote
} & (
  | { kind: 'model'; report: ModelAttestation; gpuEvidence: 'not_provided' | 'verified'; signingPublicKey?: string }
  | { kind: 'gateway'; report: GatewayAttestation; tlsSpkiFingerprint: string | null }
);

/** JSON-safe copy of `verifyResponse(id).attestation`. */
export const toStoredAttestation = (v: VerifiedCompletionResult, now = new Date()): StoredAttestation => {
  const common = {
    signer: { signingAlgo: v.attestation.signer.signingAlgo, signingAddress: v.attestation.signer.signingAddress },
    tcbStatus: v.attestation.tcbStatus,
    advisoryIds: [...v.attestation.advisoryIds],
    deploymentProvenance: v.attestation.deploymentProvenance,
    runtimeMeasurements: { ...v.attestation.deployment.runtimeMeasurements },
    verifiedAt: now.toISOString(),
  };
  if (v.signatureKind === 'provider_tee') {
    const a = v.attestation;
    return { ...common, kind: 'model', report: a.report, gpuEvidence: a.gpuEvidence, ...(a.signingPublicKey ? { signingPublicKey: a.signingPublicKey } : {}) };
  }
  const a = v.attestation;
  return { ...common, kind: 'gateway', report: a.report, tlsSpkiFingerprint: a.tlsBinding.kind === 'attested' ? a.tlsBinding.spkiFingerprint : null };
};

const sameSigner = (a: SigningIdentity, b: SigningIdentity): boolean => {
  if (a.signingAlgo !== b.signingAlgo || !(a.signingAlgo in SIGNER_BYTES)) return false;
  const x = hexBytes(a.signingAddress, SIGNER_BYTES[a.signingAlgo]);
  const y = hexBytes(b.signingAddress, SIGNER_BYTES[b.signingAlgo]);
  return !!x && !!y && x.equals(y);
};

const asVerifiedModel = (s: Extract<StoredAttestation, { kind: 'model' }>): VerifiedModelAttestation => ({
  signer: s.signer,
  tcbStatus: s.tcbStatus,
  advisoryIds: s.advisoryIds,
  deployment: { appCompose: s.report.appCompose, runtimeMeasurements: s.runtimeMeasurements },
  deploymentProvenance: s.deploymentProvenance,
  report: s.report,
  gpuEvidence: s.gpuEvidence,
  ...(s.signingPublicKey ? { signingPublicKey: s.signingPublicKey } : {}),
});

const asVerifiedGateway = (s: Extract<StoredAttestation, { kind: 'gateway' }>): VerifiedGatewayAttestation => ({
  signer: s.signer,
  tcbStatus: s.tcbStatus,
  advisoryIds: s.advisoryIds,
  deployment: { appCompose: s.report.appCompose, runtimeMeasurements: s.runtimeMeasurements },
  deploymentProvenance: s.deploymentProvenance,
  report: s.report,
  tlsBinding: s.tlsSpkiFingerprint ? { kind: 'attested', spkiFingerprint: s.tlsSpkiFingerprint } : { kind: 'none' },
});

export const ATTESTATION_BINDING_SCOPE =
  'Offline: the receipt verifies and its signer is the key named by the stored attestation report. That the report is a genuine, up-to-date TDX quote needs reverifyStoredAttestation (Intel PCCS, NVIDIA NRAS); its nonce freshness at request time cannot be re-proven later.';

export interface AttestationBindingCheck {
  ok: boolean;
  receipt: ReceiptCheck;
  kindMatches: boolean; // provider_tee pairs with a model report, gateway with a gateway report
  signerIsAttested: boolean; // receipt signer equals the stored signer and the raw report's signer (SDK check included)
  assurance: ReceiptAssurance;
  error?: string;
  scope: string;
}

/** Offline: given a stored attestation and the receipt, is the receipt's signer the attested key? */
export const verifyReceiptAgainstAttestation = (receipt: AiReceiptBytes, stored: StoredAttestation): AttestationBindingCheck => {
  const rc = checkReceipt(receipt);
  const kindMatches = (receipt.signatureKind === 'provider_tee' && stored.kind === 'model') || (receipt.signatureKind === 'gateway' && stored.kind === 'gateway');
  const receiptSigner: SigningIdentity = { signingAlgo: receipt.signingAlgo as SigningIdentity['signingAlgo'], signingAddress: receipt.signingAddress };
  let signerIsAttested = sameSigner(receiptSigner, stored.signer) && sameSigner(stored.report.signer, stored.signer);
  let error = rc.error ?? (!kindMatches ? `receipt kind ${receipt.signatureKind} does not match a ${stored.kind} attestation` : !signerIsAttested ? 'receipt signer is not the attested key' : undefined);

  if (rc.ok && kindMatches && signerIsAttested) {
    const signature: CompletionSignature = { kind: receipt.signatureKind, signer: receiptSigner, signedText: receipt.signedText, signature: receipt.signature };
    const bytes = { requestBody: new TextEncoder().encode(receipt.requestBody), responseBody: new TextEncoder().encode(receipt.responseBody), signature };
    try {
      // the SDK re-derives the signed text from the request's own model field and re-checks the signer binding
      if (stored.kind === 'model') verifyModelResponse({ ...bytes, attestation: asVerifiedModel(stored) });
      else verifyGatewayResponse({ ...bytes, attestation: asVerifiedGateway(stored) });
    } catch (e) {
      signerIsAttested = false;
      error = isVerificationError(e) ? `sdk ${e.failure.code}` : (e as Error).message.slice(0, 160);
    }
  }
  const ok = rc.ok && kindMatches && signerIsAttested;
  return { ok, receipt: rc, kindMatches, signerIsAttested, assurance: assuranceOf(receipt.signatureKind, ok), ...(error ? { error } : {}), scope: ATTESTATION_BINDING_SCOPE };
};

/**
 * Online: re-runs the SDK's quote, measurement and GPU checks on the stored raw report (Intel PCCS, NVIDIA NRAS)
 * and confirms they yield the same signer. Uses the report's own nonce, so it proves binding, not freshness.
 */
export const reverifyStoredAttestation = async (
  stored: StoredAttestation,
  acceptedTcbStatuses: readonly TcbStatus[] = ['UpToDate']
): Promise<{ ok: boolean; tcbStatus?: TcbStatus; error?: string }> => {
  try {
    const v =
      stored.kind === 'model'
        ? await verifyModelAttestation({ attestation: stored.report, clientBinding: { nonce: stored.report.nonce }, policy: { acceptedTcbStatuses } })
        : await verifyGatewayAttestation({
            attestation: stored.report,
            clientBinding: { nonce: stored.report.nonce, ...(stored.tlsSpkiFingerprint ? { spkiFingerprint: stored.tlsSpkiFingerprint } : {}) },
            policy: { acceptedTcbStatuses },
          });
    if (!sameSigner(v.signer, stored.signer)) return { ok: false, tcbStatus: v.tcbStatus, error: 'report verifies to a different signer' };
    return { ok: true, tcbStatus: v.tcbStatus };
  } catch (e) {
    return { ok: false, error: isVerificationError(e) ? `sdk ${e.failure.code}` : (e as Error).message.slice(0, 200) };
  }
};
