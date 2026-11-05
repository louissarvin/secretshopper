import { describe, expect, test } from 'bun:test';
import { roundAt, defaultChainInfo } from 'tlock-js';
import {
  assertRevealGrace,
  ciphertextSha256,
  drandRoundAt,
  drandRoundTimeMs,
  MIN_REVEAL_GRACE_MS,
  openFromChain,
  QUICKNET_CHAIN_HASH,
  sealForChain,
  TLOCK_MARGIN_MS,
  tlockHeader,
  tlockRoundBounds,
  tlockMarginMs,
  tlockRoundFor,
} from '../src/lib/proof/tlock.ts';

describe('drand quicknet round math', () => {
  test('matches tlock-js roundAt and the contract formula (t_s - 1692803367) / 3 + 1', () => {
    for (const ms of [1_692_803_367_000, 1_762_000_000_123, Date.now()]) {
      expect(drandRoundAt(ms)).toBe(roundAt(ms, defaultChainInfo));
      expect(drandRoundAt(ms)).toBe(Math.floor((Math.floor(ms / 1000) - 1_692_803_367) / 3) + 1);
    }
  });

  test('round r is published no later than the time it covers', () => {
    const r = drandRoundAt(Date.now());
    expect(drandRoundTimeMs(r)).toBeLessThanOrEqual(Date.now());
    expect(drandRoundAt(drandRoundTimeMs(r))).toBe(r);
  });

  test('tlock-js default chain is quicknet', () => expect(defaultChainInfo.hash).toBe(QUICKNET_CHAIN_HASH));
});

describe('V2-01: the chosen round opens only after expiry', () => {
  test('for any block landing within the margin, the round is inside the contract range (grace 9 s to 6 h)', () => {
    for (let i = 0; i < 6000; i++) {
      const now = 1_762_000_000_000 + Math.floor(Math.random() * 86_400_000);
      const ttl = [30_000, 172_800_000, 7_200_123][i % 3];
      const grace = [MIN_REVEAL_GRACE_MS, 60_000, 21_600_000, 10_001][i % 4];
      const round = tlockRoundFor(now, ttl, grace);
      const blockMs = now + Math.floor(Math.random() * (tlockMarginMs(grace) + 1)); // expires_at = block time + ttl
      const { min, max } = tlockRoundBounds(blockMs + ttl, grace);
      expect(round).toBeGreaterThanOrEqual(min);
      expect(round).toBeLessThanOrEqual(max);
      expect(drandRoundTimeMs(round)).toBeGreaterThan(blockMs + ttl - 1000); // published after expiry (second precision)
    }
  });

  test('the margin is a third of the grace, between 3 s and 30 s', () => {
    expect(tlockMarginMs(MIN_REVEAL_GRACE_MS)).toBe(TLOCK_MARGIN_MS);
    expect(tlockMarginMs(60_000)).toBe(20_000);
    expect(tlockMarginMs(21_600_000)).toBe(30_000);
  });

  test('reveal_grace below 9 s is refused', () => {
    expect(() => assertRevealGrace(8_999)).toThrow();
    expect(() => assertRevealGrace(9_000)).not.toThrow();
  });
});

// Live drand: run with NETWORK_TESTS=1 (needs api.drand.sh).
describe.skipIf(!process.env.NETWORK_TESTS)('tlock round trip against drand quicknet', () => {
  const preimage = { salt: 'a'.repeat(64), payee: 'f'.repeat(64), invoice_id: 'b'.repeat(64), receipt_hash: 'c'.repeat(64) };

  // a round days away is unopened however slow drand answers, so the refusal never races the clock
  test('refuses to open before the round; tests and voids have equal ciphertext size', async () => {
    const far = drandRoundAt(Date.now()) + 100_000;
    const test = await sealForChain(far, preimage);
    const voidSlot = await sealForChain(far, { salt: 'd'.repeat(64), payee: '', invoice_id: 'e'.repeat(64), receipt_hash: '0'.repeat(64) });
    expect(Buffer.from(test.ciphertextB64, 'base64').length).toBe(Buffer.from(voidSlot.ciphertextB64, 'base64').length);
    expect(tlockHeader(test.ciphertextB64)).toEqual({ round: far, chainHash: QUICKNET_CHAIN_HASH });
    expect(ciphertextSha256(test.ciphertextB64)).toBe(test.ciphertextSha256);
    await expect(openFromChain(test.ciphertextB64)).rejects.toThrow(/too early/);
  }, 60_000);

  test('opens once the round is published', async () => {
    const round = drandRoundAt(Date.now()) + 2;
    const test = await sealForChain(round, preimage);
    await Bun.sleep(Math.max(0, drandRoundTimeMs(round) - Date.now()) + 2_000);
    expect((await openFromChain(test.ciphertextB64)).payee).toBe('f'.repeat(64));
  }, 60_000);
});
