import type OpenAI from 'openai';
import { InferenceClient, isApiError } from '@nearai/inference-sdk/node';

// NEAR AI through the SDK's verified transport (docs.near.ai cloud/verification; SDK docs/verification-guide.md):
// Gateway and model attestation run before any request, and every reply's signature is checked by id.

// Only the non-streaming create the loop uses; structural so the SDK client and test doubles both fit.
export type ChatClient = { chat: { completions: { create(body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming): PromiseLike<OpenAI.Chat.ChatCompletion> } } };

/** What the decision log keeps per model step. */
export interface ReceiptRef {
  id: string;
  signature_kind: 'provider_tee' | 'gateway';
  signing_algo: string;
  signer: string;
  tcb_status: string;
}

export type VerifyReceipt = (id: string) => Promise<ReceiptRef>;

const RETRIES = 3;

const verifierFor = (client: InferenceClient): VerifyReceipt => async (id) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const v = await client.verifyResponse(id);
      return {
        id: v.id,
        signature_kind: v.signatureKind,
        signing_algo: v.signature.signer.signingAlgo,
        signer: v.signature.signer.signingAddress,
        tcb_status: v.attestation.tcbStatus,
      };
    } catch (e) {
      // api.completion_signature_unavailable is retryable; the inference itself is never re-sent
      if (attempt >= RETRIES || !isApiError(e) || !e.retryable) throw e;
      await Bun.sleep(1000 * attempt);
    }
  }
};

export const createNearAiClient = (o: { apiKey: string; baseUrl: string; e2ee: boolean }): { llm: ChatClient; verify: VerifyReceipt } => {
  // e2ee needs an attested model and rejects Gateway-only (Incognito) models before sending anything
  const client = new InferenceClient({ apiKey: o.apiKey, baseUrl: o.baseUrl, e2ee: o.e2ee, modelVerification: { policy: { acceptedTcbStatuses: ['UpToDate'] } } });
  return { llm: client, verify: verifierFor(client) };
};

/** Attests gateway and model for `model` without sending inference; rejects Incognito models with policy.model_attestation_required. */
export const attestModel = (o: { apiKey: string; baseUrl: string }, model: string): Promise<unknown> =>
  new InferenceClient({ apiKey: o.apiKey, baseUrl: o.baseUrl, modelVerification: { policy: { acceptedTcbStatuses: ['UpToDate'] } } }).verify(model);

/**
 * Evaluation only, never the production agent: Incognito models attest the Gateway alone, so receipts are
 * `gateway` kind and prove only what the Gateway signed, not that a TEE ran the model.
 */
export const createGatewayOnlyClient = (o: { apiKey: string; baseUrl: string }): { llm: ChatClient; verify: VerifyReceipt } => {
  const client = new InferenceClient({ apiKey: o.apiKey, baseUrl: o.baseUrl, e2ee: false });
  return { llm: client, verify: verifierFor(client) };
};
