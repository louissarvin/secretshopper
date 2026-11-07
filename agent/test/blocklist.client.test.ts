import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInbox, type Fetch } from '../src/inboxClient.ts';

// The agent's blocklist lookup: same inbox base URL and bearer token, bounded time and size, fails closed to an error.
const PAYEE = '3c23855018f7bc402b49e8b8d2f883f81c33b7434e3f660ca3f9277f5ee31ac6';
const TX = 'AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az';

const inboxWith = (respond: (url: string, init?: RequestInit) => Response) => {
  const seen: { url: string; auth: string | null; signal: boolean }[] = [];
  const fetch: Fetch = async (url, init) => {
    seen.push({ url, auth: new Headers(init?.headers).get('authorization'), signal: !!init?.signal });
    return respond(url, init);
  };
  const inbox = createInbox({ url: 'https://api.example.com/inbox', token: 'tok', stateFile: join(mkdtempSync(join(tmpdir(), 'bl-')), 's.json'), fetch });
  return { inbox, seen };
};
const ok = (data: unknown) => Response.json({ success: true, error: null, data });

describe('inbox blocklist lookup', () => {
  test('reads /inbox/blocklist/:accountId with the inbox token and returns the count and first evidence tx', async () => {
    const { inbox, seen } = inboxWith(() => ok({ accountId: PAYEE, listed: true, count: 2, entries: [{ evidenceTx: TX }, { evidenceTx: 'x' }] }));
    expect(await inbox.blocklist(PAYEE)).toEqual({ listed: true, count: 2, firstEvidenceTx: TX });
    expect(seen).toEqual([{ url: `https://api.example.com/inbox/blocklist/${PAYEE}`, auth: 'Bearer tok', signal: true }]);
  });

  test('not listed', async () => {
    const { inbox } = inboxWith(() => ok({ accountId: PAYEE, listed: false, count: 0, entries: [] }));
    expect(await inbox.blocklist(PAYEE)).toEqual({ listed: false, count: 0, firstEvidenceTx: null });
  });

  test('errors, a missing route, a malformed or inconsistent answer and an oversized body all throw', async () => {
    const cases: Response[] = [
      new Response('down', { status: 503 }),
      new Response('nope', { status: 404 }),
      Response.json({ success: true, data: { listed: 'yes' } }),
      ok({ listed: false, count: 1, entries: [{ evidenceTx: TX }] }),
      new Response('x'.repeat(70 * 1024)),
    ];
    for (const res of cases) {
      const { inbox } = inboxWith(() => res);
      await expect(inbox.blocklist(PAYEE)).rejects.toThrow();
    }
  });
});

describe('inbox whoami (v2/37)', () => {
  test('returns the vault the token serves; an API without the route is null', async () => {
    const { inbox, seen } = inboxWith(() => ok({ shop: 'selfserve-e2e.ss-owner-e9c3db.testnet' }));
    expect(await inbox.whoami()).toEqual({ shop: 'selfserve-e2e.ss-owner-e9c3db.testnet' });
    expect(seen[0]).toMatchObject({ url: 'https://api.example.com/inbox/whoami', auth: 'Bearer tok' });
    expect(await inboxWith(() => new Response('', { status: 404 })).inbox.whoami()).toBeNull();
    await expect(inboxWith(() => new Response('', { status: 401 })).inbox.whoami()).rejects.toThrow();
  });
});
