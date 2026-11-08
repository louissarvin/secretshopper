import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair, type KeyPairString } from 'near-api-js';

// near-cli legacy keychain: ~/.near-credentials/<network>/<account>.json with { private_key, public_key }.
// Key material is returned to the caller only; nothing here logs it.
export const credentialPath = (network: string, accountId: string): string => join(homedir(), '.near-credentials', network, `${accountId}.json`);

export const loadLegacyKey = (network: string, accountId: string): KeyPairString => {
  const p = credentialPath(network, accountId);
  if (!existsSync(p)) throw new Error(`no key for ${accountId} in ${p}`);
  if ((statSync(p).mode & 0o077) !== 0) process.stderr.write(`warning: ${p} is readable by other users; chmod 600 it\n`);
  const raw = JSON.parse(readFileSync(p, 'utf8')) as { private_key?: string; secret_key?: string };
  const key = (raw.private_key ?? raw.secret_key) as KeyPairString | undefined;
  if (!key?.startsWith('ed25519:')) throw new Error(`${p} has no ed25519 private_key`);
  KeyPair.fromString(key); // validates the format
  return key;
};
