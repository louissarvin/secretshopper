import { Account, type KeyPairString } from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import { provider } from './net.ts';

// Owner sign-in without the web app: NEP-413 through the API's /auth/nonce and /auth/verify.

export const API_URL = (process.env.API_URL || 'http://localhost:3700').replace(/\/+$/, '');

type Envelope<T> = { success: boolean; data: T; error: { code: string; message: string } | null };

export const api = async <T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: Envelope<T> }> => {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: (await res.json()) as Envelope<T> };
};

/** Returns a JWT for `accountId`, signed with its full-access key (NEP-413 requires FullAccess). */
export const signIn = async (accountId: string, key: KeyPairString): Promise<string> => {
  const nonce = await api<{ message: string; recipient: string; nonce: string }>('POST', '/auth/nonce', { accountId });
  if (!nonce.body.success) throw new Error(`/auth/nonce ${nonce.status}: ${nonce.body.error?.message}`);
  const { message, recipient } = nonce.body.data;
  const signed = await signMessage({
    signerAccount: new Account(accountId, provider, key),
    payload: { message, recipient, nonce: new Uint8Array(Buffer.from(nonce.body.data.nonce, 'base64')) },
  });
  const verify = await api<{ token: string }>('POST', '/auth/verify', {
    accountId,
    publicKey: signed.publicKey.toString(),
    signature: Buffer.from(signed.signature).toString('base64'),
    nonce: nonce.body.data.nonce,
  });
  if (!verify.body.success) throw new Error(`/auth/verify ${verify.status}: ${verify.body.error?.message}`);
  return verify.body.data.token;
};
