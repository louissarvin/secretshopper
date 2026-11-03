import { mainnetClient, timelockDecrypt, timelockEncrypt, Buffer as TBuffer } from 'tlock-js';
import { createHash } from 'node:crypto';

// drand quicknet (tlock-js mainnetClient): chain 52db9ba7...e971, genesis 1692803367 s, period 3 s.
export const QUICKNET_CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const DRAND_GENESIS_S = 1_692_803_367;
export const DRAND_PERIOD_S = 3;
export const SEALED_PLAINTEXT_BYTES = 512; // fixed size so tests and voids encrypt to equal lengths

/** round(t) = floor((t - genesis) / 3) + 1; equals tlock-js roundAt and the contract's drand_quicknet_round. */
export const drandRoundAt = (ms: number): number => Math.floor((Math.floor(ms / 1000) - DRAND_GENESIS_S) / DRAND_PERIOD_S) + 1;
/** Unix ms at which round r is published. */
export const drandRoundTimeMs = (round: number): number => (DRAND_GENESIS_S + (round - 1) * DRAND_PERIOD_S) * 1000;

// V2-01: the contract accepts round_at(expires_at) + 1 <= tlock_round <= round_at(expires_at + reveal_grace),
// so a ciphertext can only open after expiry. expires_at = commit block time + ttl, unknown when we sign.
export const TLOCK_MARGIN_MS = 3_000; // smallest margin: the commit block lands at most this long after we pick the round
export const MAX_TLOCK_MARGIN_MS = 30_000; // a reveal opens at most this much later than the earliest round
export const MIN_REVEAL_GRACE_MS = 9_000; // margin + one 3 s period + one period of rounding slack

/** Time allowed for sealing (drand fetch) and block inclusion: a third of the grace, so the round stays inside it. */
export const tlockMarginMs = (revealGraceMs: number): number => Math.min(MAX_TLOCK_MARGIN_MS, Math.max(TLOCK_MARGIN_MS, Math.floor(revealGraceMs / 3)));

/** First round after expiry, assuming the commit block lands within tlockMarginMs(revealGraceMs) of `nowMs`. */
export const tlockRoundFor = (nowMs: number, ttlMs: number, revealGraceMs: number): number => drandRoundAt(nowMs + ttlMs + tlockMarginMs(revealGraceMs)) + 1;

/** The contract's accepted range for a batch expiring at `expiresMs`. */
export const tlockRoundBounds = (expiresMs: number, revealGraceMs: number): { min: number; max: number } => ({
  min: drandRoundAt(expiresMs) + 1,
  max: drandRoundAt(expiresMs + revealGraceMs),
});

export const assertRevealGrace = (revealGraceMs: number): void => {
  if (revealGraceMs < MIN_REVEAL_GRACE_MS) throw new Error(`policy.reveal_grace must be at least ${MIN_REVEAL_GRACE_MS / 1000} s for tlock (got ${revealGraceMs / 1000} s)`);
};

export interface TlockPreimage {
  salt: string;
  payee: string;
  invoice_id: string;
  receipt_hash: string;
}

let client: ReturnType<typeof mainnetClient> | null = null;
const drand = () => (client ??= mainnetClient());

const ARMOR = (tag: string) => `${'-'.repeat(5)}${tag} AGE ENCRYPTED FILE${'-'.repeat(5)}`;

/** Encrypts the padded preimage to `round`. Returns the binary age file as base64 and its sha256 (what the chain stores). */
export const sealForChain = async (round: number, p: TlockPreimage): Promise<{ ciphertextB64: string; ciphertextSha256: string }> => {
  const body = JSON.stringify({ salt: p.salt, payee: p.payee, invoice_id: p.invoice_id, receipt_hash: p.receipt_hash });
  if (Buffer.byteLength(body) > SEALED_PLAINTEXT_BYTES) throw new Error('preimage too long to seal');
  const armored = await timelockEncrypt(round, TBuffer.from(body.padEnd(SEALED_PLAINTEXT_BYTES, ' ')), drand());
  const ciphertextB64 = armored
    .split('\n')
    .filter((l) => l && !l.startsWith('-'.repeat(5)))
    .join('');
  return { ciphertextB64, ciphertextSha256: createHash('sha256').update(Buffer.from(ciphertextB64, 'base64')).digest('hex') };
};

/** sha256 of the binary age file, the value committed on chain as ciphertext_sha256. */
export const ciphertextSha256 = (b64: string): string => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');

/** Target round read from the age header (`-> tlock <round> <chainhash>`), without drand. */
export const tlockHeader = (b64: string): { round: number; chainHash: string } | null => {
  const m = /-> tlock (\d+) ([0-9a-f]{64})/.exec(Buffer.from(b64, 'base64').subarray(0, 200).toString('latin1'));
  return m ? { round: Number(m[1]), chainHash: m[2] } : null;
};

// tlock-js 0.9.0 timelock-decrypter.js prints "beacon received: ..." with console.log; keep stdout clean for JSON logs.
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = original;
  }
};

/** drand could not be reached or returned no verified beacon: retry later, never blame the owner. */
export class DrandUnavailable extends Error {}

type Beacon = Awaited<ReturnType<ReturnType<typeof mainnetClient>['get']>>;

/** Fetches chain info and the round's beacon first, so any later failure is in the ciphertext itself. */
const prefetch = async (round: number, attempts = 4): Promise<Beacon> => {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await drand().chain().info();
      return await drand().get(round);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw new DrandUnavailable(`drand round ${round}: ${(last as Error)?.message ?? String(last)}`);
};

/** Decrypts after the round is published. Throws DrandUnavailable on network failure; any other throw means the ciphertext is bad. */
export const openFromChain = async (b64: string): Promise<TlockPreimage> => {
  const header = tlockHeader(b64);
  if (!header) throw new Error('not a tlock age file');
  if (header.chainHash !== QUICKNET_CHAIN_HASH) throw new Error(`ciphertext targets drand chain ${header.chainHash}`);
  if (drandRoundTimeMs(header.round) > Date.now()) throw new Error(`too early to decrypt: round ${header.round} not published yet`);
  const beacon = await prefetch(header.round);
  const c = drand();
  // same client, but the beacon for this round comes from the verified prefetch, not a second request
  const cached = { options: c.options, chain: () => c.chain(), latest: () => c.latest(), get: async (r: number) => (r === header.round ? beacon : c.get(r)) };
  const lines = b64.match(/.{1,64}/g) ?? [];
  const armored = [ARMOR('BEGIN'), ...lines, ARMOR('END'), ''].join('\n');
  const p = JSON.parse((await quietly(() => timelockDecrypt(armored, cached))).toString().trimEnd()) as TlockPreimage;
  return { salt: String(p.salt), payee: String(p.payee), invoice_id: String(p.invoice_id), receipt_hash: String(p.receipt_hash) };
};
