import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM, blob = base64(iv12 || tag16 || ciphertext). The key lives only in .env.tester.

export const seal = (key: Buffer, obj: unknown): string => {
  if (key.length !== 32) throw new Error('seal key must be 32 bytes');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};

/** Throws if the blob was modified or the key is wrong (GCM tag check). */
export const unseal = <T>(key: Buffer, b64: string): T => {
  if (key.length !== 32) throw new Error('seal key must be 32 bytes');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 29) throw new Error('sealed blob too short');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')) as T;
};
