import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleAmount, vendorAmounts } from '../src/tester/amounts.ts';
import { newTestPayee } from '../src/tester/payees.ts';
import { nextRealDelivery, testDeliveryTimes } from '../src/utils/delivery.ts';
import { buildGeneratorInput, parseDraft, SYNTHETIC_STYLE } from '../src/tester/generator.ts';
import { emailSchema } from '../src/utils/intake.ts';
import { publicSlotRow } from '../src/tester/slots.ts';
import { shouldAbandon, TESTER_SCHEDULES, TX_VALIDITY_MS } from '../src/tester/recovery.ts';
import { isValidAccountId } from '../src/utils/ids.ts';

// Regression tests for 21_security_audit.md SS-B01 to SS-B07. Each inverts the audit's PoC: the attack must now fail.
const ROOT = join(import.meta.dir, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('SS-B01 lure amount and payee shape are not constants', () => {
  const USDC = 1_000_000n;
  test('amounts come from the vendor history, jittered, many distinct values, within the cap', () => {
    const history = vendorAmounts([{ amount: '1200000' }, { amount: '1750000' }], [{ total: '0.95' }], 6);
    expect(history).toEqual([1_200_000n, 1_750_000n, 950_000n]);
    const draws = Array.from({ length: 300 }, () => sampleAmount(history, 2n * USDC, 6));
    expect(new Set(draws).size).toBeGreaterThan(20);
    expect(draws.includes('1.00') && new Set(draws).size === 1).toBe(false);
    for (const d of draws) {
      const units = Math.round(Number(d) * 1e6);
      expect(units).toBeGreaterThan(0);
      expect(units).toBeLessThanOrEqual(2_000_000);
      // within 15% of some real amount (or clamped to the cap)
      expect(history.some((h) => Math.abs(units - Number(h)) <= Number(h) * 0.15 + 10_000) || units === 2_000_000).toBe(true);
    }
  });

  test('no history still varies (20% to 90% of the cap)', () => {
    const draws = Array.from({ length: 200 }, () => sampleAmount([], 2n * USDC, 6));
    expect(new Set(draws).size).toBeGreaterThan(20);
  });

  test('the tester has no constant amount setting left', () => {
    expect(src('src/tester/config.ts')).not.toContain('TEST_AMOUNT =');
    expect(src('src/tester/workers.ts')).toContain('sampleAmount(');
  });

  test('payees mix 64-hex implicit and 0x eth-implicit, all valid NEAR account ids', () => {
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = newTestPayee(50);
      kinds.add(p.kind);
      expect(isValidAccountId(p.payee)).toBe(true);
      expect(p.kind === 'eth_implicit' ? /^0x[0-9a-f]{40}$/.test(p.payee) : /^[0-9a-f]{64}$/.test(p.payee)).toBe(true);
    }
    expect([...kinds].sort()).toEqual(['eth_implicit', 'near_implicit']);
  });
});

describe('SS-B02 release ticks: no test-free hours', () => {
  const ticks = (realHistory: Date[]) => {
    const hours = new Set<number>();
    for (let d = 0; d < 30; d++) {
      const commit = new Date(Date.UTC(2026, 10, 2 + d, 0, 0, 5));
      const expiresAt = new Date(commit.getTime() + 2 * 86_400_000);
      for (const t of testDeliveryTimes(50, { now: commit, expiresAt, periodMinutes: 120, realHistory, businessStartHourUtc: 8, businessEndHourUtc: 18 })) hours.add(t.getUTCHours());
    }
    return hours;
  };

  test('tests only land at hours where real invoices land (audit PoC inverted)', () => {
    const real = [10, 14, 16, 22].map((h) => new Date(Date.UTC(2026, 9, 20, h)));
    const testHours = ticks(real);
    expect([...testHours].every((h) => [10, 14, 16, 22].includes(h))).toBe(true);
    expect(testHours.has(22)).toBe(true); // the night tick the PoC proved test-free now carries tests
  });

  test('a real invoice entered at 22:03 waits for the 00:00 tick, and tests use the same grid', () => {
    const real = nextRealDelivery(new Date(Date.UTC(2026, 10, 3, 22, 3)), 120);
    expect(real.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(ticks([real]).has(0)).toBe(true);
  });
});

describe('SS-B03 one intake normaliser for real and test items', () => {
  const payee = 'f'.repeat(64);
  const draft = (from_email: string, from_name = 'Acme Billing', body = `pay ${payee}`) =>
    JSON.stringify({ email: { from_name, from_email, subject: 'Invoice', body }, invoice: { total: '1.37', pay_to: payee } });

  test('display-name address and homoglyph domain are rejected for tests, as for real invoices', () => {
    expect(() => parseDraft(draft('Acme Billing <billing@acme.example>'), payee)).toThrow();
    expect(() => parseDraft(draft('billing@acme‑hosting.com'), payee)).toThrow();
    expect(emailSchema.safeParse({ from_name: 'A', from_email: 'Acme Billing <billing@acme.example>', subject: 'x', body: 'x' }).success).toBe(false);
  });

  test('a padded name is normalised to exactly the bytes real intake would store', () => {
    const t = parseDraft(draft('billing@acme.example', ' Acme Billing '), payee);
    const real = emailSchema.parse({ from_name: ' Acme Billing ', from_email: 'billing@acme.example', subject: 'Invoice', body: `pay ${payee}` });
    expect(t.email).toEqual(real);
  });

  test('wording that marks a test is rejected', () => {
    for (const body of [`This is a test. Pay ${payee}`, `ITF scenario: pay ${payee}`, `internal control check, pay ${payee}`]) {
      expect(() => parseDraft(draft('billing@acme.example', 'Acme Billing', body), payee)).toThrow();
    }
    expect(() => parseDraft(draft('billing@acme.example', 'Acme Billing', `Latest invoice, please pay ${payee}`), payee)).not.toThrow();
  });

  test('a domain outside the inbox convention is rejected, so domains cannot separate tests from real mail', () => {
    expect(() => parseDraft(draft('billing@acme.com', 'Acme Billing', `pay ${payee}`), payee)).toThrow(/outside \.example/);
    expect(() => parseDraft(draft('billing@acme.example', 'Acme Billing', `see portal.acme.io, pay ${payee}`), payee)).toThrow();
  });
});

describe('SS-B04 test linkage stays out of the API database role', () => {
  const schema = src('prisma/schema.prisma');
  const modelBlock = (name: string) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf('}', schema.indexOf(`model ${name} {`)));

  test('sealed preimages and generation receipts live in schema "tester"', () => {
    expect(modelBlock('SealedSlot')).toContain('@@schema("tester")');
    expect(modelBlock('GenerationAttempt')).toContain('@@schema("tester")');
  });

  test('the public slot row written at commit has no linkage fields', () => {
    const row = publicSlotRow({ commitment: 'a'.repeat(64), expires_at: '1800000000000000000', batch: 0, tlock_round: 5, ciphertext_sha256: 'b'.repeat(64) });
    expect(Object.keys(row).sort()).toEqual(['batchIndex', 'ciphertextSha256', 'commitment', 'expiresAt', 'status', 'tlockRound']);
  });

  test('no API-side file touches tester tables', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const apiFiles = [join(ROOT, 'index.ts'), ...walk(join(ROOT, 'src')).filter((f) => !f.includes('/src/tester/') && f.endsWith('.ts'))];
    const offenders = apiFiles.filter((f) => /\b(sealedSlot|generationAttempt)\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('roles.sql gives the API role nothing in schema tester and hides v1 sealed columns', () => {
    const sql = src('prisma/roles.sql');
    expect(sql).toContain('REVOKE ALL ON SCHEMA tester FROM ss_api');
    expect(/GRANT[^;]*SCHEMA tester[^;]*ss_api/.test(sql)).toBe(false);
    expect(sql).toContain('REVOKE SELECT ON public.tests FROM ss_api');
    expect(/GRANT SELECT \([^)]*"sealed"/.test(sql)).toBe(false);
  });
});

describe('SS-B05 generator input contains only the public style set', () => {
  const vendor = {
    legalName: 'Acme Hosting LLC',
    contactEmail: 'billing@acme.example',
    sampleInvoices: [{ iban: 'DE89370400440532013000', pay_to: 'acme.near', total: '9.00' }],
    approvedPayees: [{ account: 'acme.near', rail: 'Near' }],
    styleSet: [{ number: 'INV-1', total: '1.10', pay_to: '<account>' }],
  };

  test('private samples and approved payees never reach the request bytes', () => {
    const body = JSON.stringify(buildGeneratorInput({ company: 'Kwek Labs', category: 'bank_change', vendor, payee: 'f'.repeat(64), amount: '1.05' }));
    expect(body).not.toContain('DE89370400440532013000');
    expect(body).not.toContain('acme.near');
    expect(body).toContain('INV-1');
  });

  test('with no approved style set the generator gets the synthetic style, never private samples', () => {
    const input = buildGeneratorInput({ company: 'Kwek Labs', category: 'ceo_urgent', vendor: { ...vendor, styleSet: [] }, payee: 'f'.repeat(64), amount: '1.05' });
    expect(input.samples).toEqual(SYNTHETIC_STYLE);
  });
});

describe('SS-B06 NEP-413 recipient guard', () => {
  const runConfig = (recipient: string) => {
    const cwd = mkdtempSync(join(tmpdir(), 'ss-b06-')); // empty dir: no .env is auto-loaded
    return Bun.spawnSync(['bun', '-e', `await import(${JSON.stringify(join(ROOT, 'src/config/main-config.ts'))})`], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        AUTH_RECIPIENT: recipient,
        DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/z',
        JWT_SECRET: 'x'.repeat(40),
        SHOP_CONTRACT_ID: 'shop.example.testnet',
        INBOX_TOKEN_HASH: createHash('sha256').update('t').digest('hex'),
        CORS_ORIGINS: 'https://app.example.com',
      },
    });
  };

  test('production refuses localhost', () => {
    const r = runConfig('localhost');
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('AUTH_RECIPIENT');
    expect(runConfig('127.0.0.1:3200').exitCode).toBe(1);
  });

  test('production accepts the real host', () => expect(runConfig('app.example.com').exitCode).toBe(0));
});

describe('SS-B07 crash recovery timing', () => {
  const created = new Date('2026-11-02T00:00:00Z');

  test('a slot found on chain is never abandoned', () => expect(shouldAbandon(created, created.getTime() + 10 * TX_VALIDITY_MS, true)).toBe(false));

  test('absent slots are not abandoned while the commit tx could still land (the old 1 h rule is gone)', () => {
    expect(shouldAbandon(created, created.getTime() + 2 * 3_600_000, false)).toBe(false);
    expect(shouldAbandon(created, created.getTime() + TX_VALIDITY_MS + 1, false)).toBe(true);
  });

  test('recovery runs at tester start and every 10 minutes, not only at the next daily commit', () => {
    expect(TESTER_SCHEDULES.recover).toBe('*/10 * * * *');
    const entry = src('tester.ts');
    // multi-vault: every job takes a vault context; the default vault recovers first, then the scheduled run covers every vault
    expect(entry.indexOf('await recoverPrepared(def)')).toBeGreaterThan(-1);
    expect(entry.indexOf('await recoverPrepared(def)')).toBeLessThan(entry.indexOf('startTesterWorkers()'));
    expect(src('src/tester/workers.ts')).toContain('cron.schedule(TESTER_SCHEDULES.recover, each(recoverPrepared))');
  });

  test('a late recovery never schedules delivery at or after expiry', () => {
    const now = new Date('2026-11-03T23:59:00Z');
    const expiresAt = new Date('2026-11-04T00:00:05Z');
    for (const t of testDeliveryTimes(20, { now, expiresAt, periodMinutes: 120, realHistory: [], businessStartHourUtc: 8, businessEndHourUtc: 18 })) {
      expect(t.getTime()).toBeLessThan(expiresAt.getTime());
    }
  });
});
