import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { isFastnearHost } from '../src/vault.ts';

const SRC = join(import.meta.dir, '..', 'src');
// Placeholders only; cwd is a temp dir so Bun loads no .env.
const BASE = { PATH: process.env.PATH ?? '', AGENT_VAULT_ID: 'v.testnet', AGENT_PRIVATE_KEY: 'ed25519:x', INBOX_URL: 'https://inbox.example.com', INBOX_TOKEN: 't', NEARAI_API_KEY_AGENT: 'k' };
const run = (code: string, env: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const r = Bun.spawnSync([process.execPath, '-e', code], { cwd: dir, env: { ...BASE, ...env } });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString(), dir };
};

describe('agent config and hosts', () => {
  test('AG-06: numeric settings are bounded integers', () => {
    const load = `await import(${JSON.stringify(join(SRC, 'config.ts'))})`;
    expect(run(load, {}).ok).toBe(true);
    for (const [k, v] of [['AGENT_PAY_INTENTS_TGAS', 'lots'], ['AGENT_PAY_INTENTS_TGAS', '50'], ['AGENT_PAY_TGAS', '301'], ['TOKEN_DECIMALS', '0'], ['AGENT_CALL_TGAS', '2.5'], ['AGENT_POLL_MS', '-1']]) {
      const r = run(load, { [k]: v });
      expect(r.ok).toBe(false);
      expect(r.out).toContain(`${k} must be an integer`);
    }
  });

  test('AG-05: the FastNEAR key goes to fastnear.com and its subdomains only', () => {
    expect(isFastnearHost('https://rpc.testnet.fastnear.com')).toBe(true);
    expect(isFastnearHost('https://fastnear.com/x')).toBe(true);
    for (const u of ['https://evilfastnear.com', 'https://fastnear.com.evil.io', 'https://rpc.testnet.near.org']) expect(isFastnearHost(u)).toBe(false);
  });

  test('AG-01: ticks from the old independent ack walk are dropped on load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-state-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ cursor: null, attempts: {}, acks: { cursor: { afterAt: 'x', afterId: 'y' }, open: { receivedAt: '2026-11-10T08:00:00.000Z', ids: ['ab'] }, pending: [{ receivedAt: 'x', root: 'r', count: 1, attempts: 0 }], acked: ['1'] } }));
    const code = `const m = await import(${JSON.stringify(join(SRC, 'inbox.ts'))}); console.log(JSON.stringify((await m.loadState()).acks));`;
    const r = run(code, { AGENT_STATE_FILE: file });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.out.trim())).toEqual({ open: null, last: null, pending: [], acked: ['1'] });
    expect(readFileSync(file, 'utf8')).toContain('afterId'); // loading never rewrites the file
  });

  test('AG-03: an invoice given up after repeated failures stays out of the ack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-state-'));
    const code = `const m = await import(${JSON.stringify(join(SRC, 'inbox.ts'))});
      const s = await m.loadState();
      const at = '2026-11-10T08:00:00.000Z';
      await m.advance(s, { id: 'a'.repeat(64), receivedAt: at, email: {}, document: {} });
      await m.advance(s, { id: 'b'.repeat(64), receivedAt: at, email: {}, document: {} }, { ack: false });
      console.log(JSON.stringify({ ids: s.acks.open.ids, cursor: s.cursor.afterId }));`;
    const r = run(code, { AGENT_STATE_FILE: join(dir, 'state.json') });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.out.trim().split('\n').at(-1)!)).toEqual({ ids: ['a'.repeat(64)], cursor: 'b'.repeat(64) });
  });
});

describe('AG-08: inbox payload bound', () => {
  test('bodies at the limit parse, one byte over or a larger declared length is refused', async () => {
    for (const [k, v] of Object.entries(BASE)) process.env[k] ||= v; // config.ts needs the placeholders in-process too
    const { readBounded, MAX_INBOX_BYTES } = await import('../src/inbox.ts');
    const ok = 'x'.repeat(MAX_INBOX_BYTES);
    expect(await readBounded(new Response(ok), MAX_INBOX_BYTES, 't')).toBe(ok);
    await expect(readBounded(new Response(`${ok}y`), MAX_INBOX_BYTES, 't')).rejects.toThrow('exceeds the');
    const declared = new Response('{}', { headers: { 'content-length': String(MAX_INBOX_BYTES + 1) } });
    await expect(readBounded(declared, MAX_INBOX_BYTES, 't')).rejects.toThrow('over the');
    // a chunked stream is counted as it arrives, never buffered whole
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(MAX_INBOX_BYTES / 2)); c.close(); },
    });
    await expect(readBounded(new Response(stream), MAX_INBOX_BYTES, 't')).rejects.toThrow('exceeds the');
  });
});
