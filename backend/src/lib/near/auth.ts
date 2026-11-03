import { randomBytes } from 'node:crypto';
import { base58 } from '@scure/base';
import { verifyMessage } from 'near-api-js/nep413';
import { rpc } from './client.ts';
import { createLogger } from '../../utils/logger.ts';

const log = createLogger('nep413');

export const createNonce = (): string => randomBytes(32).toString('base64');

// NEP-413 says base64; tolerate wallets that return "ed25519:<base58>".
const decodeSignature = (signature: string): Uint8Array =>
  signature.startsWith('ed25519:')
    ? base58.decode(signature.slice('ed25519:'.length))
    : new Uint8Array(Buffer.from(signature, 'base64'));

/** True if `signature` is a NEP-413 signature by a FullAccess key of `accountId` over this exact payload. */
export const verifyNep413 = async (p: {
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
  recipient: string;
  nonceB64: string;
}): Promise<boolean> => {
  const nonce = new Uint8Array(Buffer.from(p.nonceB64, 'base64'));
  if (nonce.length !== 32) return false;
  try {
    // throws on bad signature, missing key, or a non FullAccess key
    await verifyMessage({
      signerAccountId: p.accountId,
      signerPublicKey: p.publicKey,
      signature: decodeSignature(p.signature),
      payload: { message: p.message, recipient: p.recipient, nonce },
      provider: rpc,
    });
    return true;
  } catch (error) {
    log.warn('verification failed', { accountId: p.accountId, reason: (error as Error).message });
    return false;
  }
};
