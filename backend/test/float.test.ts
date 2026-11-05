import { describe, expect, test } from 'bun:test';
import { floatHeadroom } from '../src/lib/near/shop.ts';

const NEAR = 10n ** 24n;

describe('reveal float headroom (V2-09)', () => {
  test('matches the contract reserve: storage at 1e19 yocto per byte plus the float', () => {
    // 3 NEAR balance, 287,179 B of code and state (v2/26), 0.5 NEAR float
    expect(floatHeadroom(3n * NEAR, 287_179, NEAR / 2n)).toBe(3n * NEAR - 287_179n * 10n ** 19n - NEAR / 2n);
  });

  test('goes negative exactly when the contract would refuse agent and tester writes', () => {
    expect(floatHeadroom(NEAR, 50_000, NEAR / 2n)).toBe(0n);
    expect(floatHeadroom(NEAR - 1n, 50_000, NEAR / 2n) < 0n).toBe(true);
  });

  test('holds back open reveals above the float (V21-05) and the armed gas-key re-key (V23-08), like reserve()', () => {
    const base = floatHeadroom(3n * NEAR, 50_000, NEAR / 2n);
    // 1000 open slots owe 600 B each = 6 NEAR of storage, more than the 0.5 NEAR float
    expect(floatHeadroom(3n * NEAR, 50_000, NEAR / 2n, { openSlots: 1000 })).toBe(base + NEAR / 2n - 1000n * 600n * 10n ** 19n);
    // 10 open slots owe 0.06 NEAR, below the float: the float still rules
    expect(floatHeadroom(3n * NEAR, 50_000, NEAR / 2n, { openSlots: 10 })).toBe(base);
    const quarter = NEAR / 4n;
    expect(floatHeadroom(3n * NEAR, 50_000, NEAR / 2n, { armedGasKey: true, keyAllowanceYocto: quarter })).toBe(base - quarter);
    expect(floatHeadroom(3n * NEAR, 50_000, NEAR / 2n, { armedGasKey: false, keyAllowanceYocto: quarter })).toBe(base);
  });
});
