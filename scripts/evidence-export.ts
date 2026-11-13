/**
 * Writes scripts/evidence/<shop>.json from the API so verifiers do not depend on our server staying up.
 * Usage: bun evidence-export.ts <shop> [api base url, default http://localhost:3700]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [shop, api = 'http://localhost:3700'] = process.argv.slice(2);
if (!shop) {
  console.error('usage: bun evidence-export.ts <shop> [api base url]');
  process.exit(2);
}
const res = await fetch(`${api.replace(/\/+$/, '')}/public/evidence/${encodeURIComponent(shop)}`);
const body = (await res.json()) as { success: boolean; data: unknown; error: { message: string } | null };
if (!res.ok || !body.success) {
  console.error(`export failed: ${res.status} ${body.error?.message ?? ''}`);
  process.exit(1);
}
const dir = join(import.meta.dir, 'evidence');
mkdirSync(dir, { recursive: true });
const text = JSON.stringify(body.data, null, 2) + '\n';
const file = join(dir, `${shop}.json`);
writeFileSync(file, text);
console.log(JSON.stringify({ file, sha256: createHash('sha256').update(text).digest('hex') }));
