import { describe, expect, test } from 'bun:test';
import { candidateTicks, nextRealDelivery, roundUpToSlot, testDeliveryTimes } from '../src/utils/delivery.ts';

const MIN = 60_000;
const at = (iso: string) => new Date(iso);
const base = { periodMinutes: 120, businessStartHourUtc: 8, businessEndHourUtc: 18 };

describe('release ticks', () => {
  test('real invoices wait for the next 2 h tick', () => {
    expect(nextRealDelivery(at('2026-11-02T10:07:00Z'), 120).toISOString()).toBe('2026-11-02T12:00:00.000Z');
    expect(nextRealDelivery(at('2026-11-02T22:03:00Z'), 120).toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  test('tests land on ticks, before expiry, in the first half of the lifetime', () => {
    const now = at('2026-11-02T00:00:05Z');
    const expiresAt = at('2026-11-04T00:00:05Z');
    for (const t of testDeliveryTimes(100, { ...base, now, expiresAt, realHistory: [] })) {
      expect(t.getTime() % (120 * MIN)).toBe(0);
      expect(t.getTime()).toBeLessThan(expiresAt.getTime());
      expect(t.getTime()).toBeLessThanOrEqual(now.getTime() + (expiresAt.getTime() - now.getTime()) / 2);
    }
  });

  test('no tick before expiry means no delivery', () => {
    const now = at('2026-11-02T10:01:00Z');
    expect(testDeliveryTimes(3, { ...base, now, expiresAt: new Date(now.getTime() + 30_000), realHistory: [] })).toEqual([]);
    expect(candidateTicks({ now, expiresAt: new Date(now.getTime() + 30_000), periodMinutes: 120 })).toEqual([]);
  });

  test('roundUpToSlot is strictly after the input', () => expect(roundUpToSlot(120 * MIN, 120)).toBe(240 * MIN));
});
