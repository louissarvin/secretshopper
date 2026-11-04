import type OpenAI from 'openai';
import { InferenceClient } from '@nearai/inference-sdk/node';
import type { AiReceiptBytes } from './receipt.ts';
import { toStoredAttestation, verifyReceiptAgainstAttestation, type StoredAttestation } from '../lib/proof/attestation.ts';

export class NearAiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodySnippet: string
  ) {
    super(`NEAR AI HTTP ${status}`);
  }
}

export type VerifiedChat = (body: Record<string, unknown> & { model: string }) => Promise<{
  completion: OpenAI.Chat.ChatCompletion;
  receipt: AiReceiptBytes;
  attestation: StoredAttestation; // what binds the receipt signer to a TEE; persist it with the receipt
}>;

/**
 * Plaintext (no E2EE) chat through the SDK's verified transport, so the exact request and response
 * bytes can be published after the reveal. Strict TCB, then our own signature and signer-binding check.
 */
export const DEFAULT_NEARAI_TIMEOUT_MS = 900_000;

/** Rejects when `p` is still pending after `ms`; the fetch itself is cut by its own AbortSignal. */
const withDeadline = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`NEAR AI ${what} exceeded ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

export const createVerifiedChat = ({ apiKey, baseUrl, timeoutMs = DEFAULT_NEARAI_TIMEOUT_MS }: { apiKey: string; baseUrl: string; timeoutMs?: number }): VerifiedChat => {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('NEAR AI timeoutMs must be an integer of at least 1000');
  const strict = { policy: { acceptedTcbStatuses: ['UpToDate'] as const } };
  const ai = new InferenceClient({
    baseUrl,
    apiKey,
    signingAlgo: 'ecdsa', // receipts already published are ecdsa; checkReceipt also handles ed25519
    e2ee: false,
    gatewayVerification: strict,
    modelVerification: strict,
  });
  const url = new URL('chat/completions', ai.getBaseUrl()).toString();

  return async (body) => {
    const requestBody = JSON.stringify(body);
    // the SDK adds bearer auth and x-no-aliasing; identity keeps the response bytes uncompressed
    // one deadline covers the request, the body and the verification round trip; a hung model call never stalls the tester
    const res = await ai.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseBody = await withDeadline(res.text(), timeoutMs, 'response body');
    if (!res.ok) throw new NearAiHttpError(res.status, responseBody.slice(0, 200));
    const completion = JSON.parse(responseBody) as OpenAI.Chat.ChatCompletion;
    const verified = await withDeadline(ai.verifyResponse(completion.id), timeoutMs, 'verification');
    const { signedText, signature, signer } = verified.signature;
    const receipt: AiReceiptBytes = {
      responseId: verified.id,
      model: body.model,
      signatureKind: verified.signatureKind,
      signingAlgo: signer.signingAlgo,
      signingAddress: signer.signingAddress,
      signedText,
      signature,
      requestBody,
      responseBody,
    };
    const attestation = toStoredAttestation(verified);
    const check = verifyReceiptAgainstAttestation(receipt, attestation);
    if (!check.ok) throw new Error(`receipt does not bind (text ${check.receipt.textMatches}, signer ${check.receipt.signerMatches}, attested ${check.signerIsAttested})`);
    return { completion, receipt, attestation };
  };
};
