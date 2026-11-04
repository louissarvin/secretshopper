import { randomInt } from 'node:crypto';

// SS-B01: a lure's amount comes from the vendor's real amounts, jittered, never a constant.

const cryptoRand = (): number => randomInt(0, 2 ** 32) / 2 ** 32;

/** Base-unit amounts found in a vendor's real history (payments) and its public style set (`total` fields). */
export const vendorAmounts = (payments: { amount: string }[], styleSet: unknown[], decimals: number): bigint[] => {
  const out: bigint[] = [];
  for (const p of payments) if (/^[1-9]\d{0,38}$/.test(p.amount)) out.push(BigInt(p.amount));
  for (const s of styleSet) {
    const total = (s as { total?: unknown })?.total;
    if (typeof total === 'string' && new RegExp(`^\\d{1,15}(\\.\\d{1,${decimals}})?$`).test(total)) {
      const [w, f = ''] = total.split('.');
      const v = BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
      if (v > 0n) out.push(v);
    }
  }
  return out;
};

/** Base units to a decimal string truncated to the cent. */
export const unitsToDecimal = (units: bigint, decimals: number): string => {
  const s = units.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals, -decimals + 2)}`;
};

/**
 * Picks a real amount at random and jitters it by up to 15%, rounded to the cent, within (0, maxPerPayment].
 * With no history it draws uniformly from 20% to 90% of maxPerPayment. Returns a decimal string.
 */
export const sampleAmount = (amounts: bigint[], maxPerPayment: bigint, decimals: number, rand: () => number = cryptoRand): string => {
  const cent = 10n ** BigInt(Math.max(0, decimals - 2));
  let units: bigint;
  if (amounts.length > 0) {
    const base = amounts[Math.floor(rand() * amounts.length)];
    const factor = 0.85 + rand() * 0.3;
    units = BigInt(Math.round(Number(base) * factor));
  } else {
    units = BigInt(Math.round(Number(maxPerPayment) * (0.2 + rand() * 0.7)));
  }
  units = (units / cent) * cent;
  if (units > maxPerPayment) units = (maxPerPayment / cent) * cent;
  if (units < cent) units = cent;
  return unitsToDecimal(units, decimals);
};
