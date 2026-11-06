import { rename, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { emptyAckState, noteDone, type AckState } from './acks.ts';
import { log } from './log.ts';

// Inbox API client and decision-loop state, with no config import so the native agent and the MCP server can share it.

const HEX32 = /^[0-9a-f]{64}$/;

const itemSchema = z.object({
  id: z.string().regex(HEX32),
  receivedAt: z.iso.datetime(),
  email: z.unknown(),
  document: z.unknown(),
});
export type InboxItem = z.infer<typeof itemSchema> & { email: unknown; document: unknown };

const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ success: z.literal(true), data });

const blocklistSchema = z.object({
  listed: z.boolean(),
  count: z.number().int().min(0),
  entries: z.array(z.object({ evidenceTx: z.string() })),
});
const BLOCKLIST_TIMEOUT_MS = 5_000;
const MAX_BLOCKLIST_BYTES = 64 * 1024;

// AG-08: twice the API's 64 KB intake bodyLimit, so a compromised inbox cannot cost memory or model spend.
export const MAX_INBOX_BYTES = 128 * 1024;

/** Reads at most `limit` bytes; a longer body is an error, not a truncated parse. */
export const readBounded = async (res: Response, limit: number, what: string): Promise<string> => {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) throw new Error(`${what} body is ${declared} bytes, over the ${limit} byte limit`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`${what} body exceeds the ${limit} byte limit`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

export type Cursor = { afterAt: string; afterId: string };
// inference: the native agent's rolling usage window (src/usage.ts), checked by loadUsage before use
export type State = { cursor: Cursor | null; attempts: Record<string, number>; acks: AckState; inference?: unknown };
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface InboxOptions {
  url: string;
  token: string;
  stateFile: string;
  fetch?: Fetch; // tests
}

export const createInbox = (o: InboxOptions) => {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));

  const get = async (path: string, timeoutMs = 15_000, maxBytes = MAX_INBOX_BYTES): Promise<unknown> => {
    const res = await doFetch(`${o.url}${path}`, {
      headers: { authorization: `Bearer ${o.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const name = `inbox ${path.split('?')[0]}`;
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${name} returned ${res.status}`);
    return JSON.parse(await readBounded(res, maxBytes, name));
  };

  const saveState = async (state: State): Promise<void> => {
    // write then rename, so a crash never leaves a half-written cursor
    const tmp = `${o.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, o.stateFile);
  };

  return {
    nextInvoice: async (cursor: Cursor | null): Promise<InboxItem | null> => {
      const q = cursor ? `?afterAt=${encodeURIComponent(cursor.afterAt)}&afterId=${cursor.afterId}` : '';
      const body = await get(`/next${q}`);
      return envelope(itemSchema.nullable()).parse(body).data;
    },

    /** Vendor master record; null if the inbox does not know the id. */
    getVendor: async (vendorId: string): Promise<unknown> => {
      const body = await get(`/vendors/${encodeURIComponent(vendorId)}`);
      return body === null ? null : envelope(z.unknown()).parse(body).data;
    },

    /** The vault this inbox token serves; null when the API predates /inbox/whoami (404). */
    whoami: async (): Promise<{ shop: string } | null> => {
      const body = await get('/whoami', BLOCKLIST_TIMEOUT_MS, MAX_BLOCKLIST_BYTES);
      return body === null ? null : envelope(z.object({ shop: z.string().min(2).max(64) })).parse(body).data;
    },

    /** Shared blocklist entry for a payee. Throws on any failure, so the preflight can warn instead of allowing. */
    blocklist: async (accountId: string): Promise<{ listed: boolean; count: number; firstEvidenceTx: string | null }> => {
      const body = await get(`/blocklist/${encodeURIComponent(accountId)}`, BLOCKLIST_TIMEOUT_MS, MAX_BLOCKLIST_BYTES);
      if (body === null) throw new Error('inbox /blocklist is not served by this API');
      const d = envelope(blocklistSchema).parse(body).data;
      // listed must agree with the entries, or a broken answer could read as clean
      if (d.listed !== d.entries.length > 0) throw new Error('inbox /blocklist answer is inconsistent');
      return { listed: d.listed, count: d.count, firstEvidenceTx: d.entries[0]?.evidenceTx ?? null };
    },

    loadState: async (): Promise<State> => {
      try {
        const s = JSON.parse(await readFile(o.stateFile, 'utf8')) as Partial<State>;
        // ticks built by the old independent ack walk (it kept its own cursor) may hold ids never decided on: drop them
        const legacy = !!s.acks && 'cursor' in s.acks;
        const acks = legacy ? { ...emptyAckState(), acked: s.acks!.acked ?? [] } : { ...emptyAckState(), ...s.acks };
        return { cursor: s.cursor ?? null, attempts: s.attempts ?? {}, acks, ...(s.inference !== undefined ? { inference: s.inference } : {}) };
      } catch {
        return { cursor: null, attempts: {}, acks: emptyAckState() };
      }
    },

    saveState,

    /**
     * Moves past an item. Only items the loop decided or found decided go into an ack (AG-01); a given-up item does not,
     * so an input the model cannot process is never proven Ignored (AG-03).
     */
    advance: async (state: State, item: InboxItem, opts: { ack: boolean } = { ack: true }): Promise<void> => {
      if (opts.ack && !noteDone(state.acks, item)) log.warn('item from a closed tick is left out of the ack', { invoice: item.id, receivedAt: item.receivedAt });
      state.cursor = { afterAt: item.receivedAt, afterId: item.id };
      delete state.attempts[item.id];
      await saveState(state);
    },
  };
};

export type Inbox = ReturnType<typeof createInbox>;
