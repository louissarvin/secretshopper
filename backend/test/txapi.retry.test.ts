import { afterAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

// stub FastNEAR: 429 twice (Retry-After 1), then a page
let hits = 0;
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () => (++hits <= 2 ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }) : Response.json({ account_txs: [{ transaction_hash: 'h1' }], resume_token: '' })),
});
afterAll(() => server.stop(true));

describe('FastNEAR tx API', () => {
  test('a 429 is retried after Retry-After, not surfaced as an indexer failure', async () => {
    // own process: config is read at import time, and other test files may have imported it already
    const events = resolve(import.meta.dir, '../src/lib/near/events.ts');
    const p = Bun.spawn(['bun', '-e', `const { listContractTxHashes } = await import(${JSON.stringify(events)}); console.log(JSON.stringify(await listContractTxHashes('shop.testnet', 1, 2)));`], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NEAR_NETWORK: 'testnet', NEAR_TX_API_URL: `http://127.0.0.1:${server.port}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual(['h1']);
    expect(hits).toBe(3);
  }, 15_000);
});
