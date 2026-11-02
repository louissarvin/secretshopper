import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';

// Pure: no config, DB or logger imports, so config can validate URLs at startup and tests can use it without env.

export const MAX_WEBHOOK_URLS = 5;
export const SIGNATURE_HEADER = 'X-SecretShopper-Signature';
export const TIMESTAMP_HEADER = 'X-SecretShopper-Timestamp';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const ipv4 = (host: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? m.slice(1).map(Number) : null;
};

/** Literal addresses a webhook must never reach (SSRF): private, link-local (cloud metadata), CGNAT, multicast, reserved. */
export const isBlockedHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase();
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (h.startsWith('[') || h.includes(':')) {
    const v6 = h.replace(/^\[|\]$/g, '');
    // "::" prefix: unspecified, loopback, IPv4-mapped and IPv4-compatible; 64:ff9b: NAT64 and 2002: 6to4 embed an IPv4
    return v6.startsWith('::') || v6.startsWith('64:ff9b:') || v6.startsWith('2002:') || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
  }
  return false;
};

export const isLoopbackUrl = (url: string): boolean => LOOPBACK_HOSTS.has(new URL(url).hostname);

export type Resolve = (hostname: string) => Promise<string[]>;
const resolveAll: Resolve = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

/** True if every address the URL's host resolves to now is public. Loopback URLs (local testing) are not resolved. */
export const resolvesPublic = async (url: string, resolve: Resolve = resolveAll): Promise<boolean> => {
  if (isLoopbackUrl(url)) return true;
  const host = new URL(url).hostname;
  if (isBlockedHost(host)) return false;
  const addresses = await resolve(host.replace(/^\[|\]$/g, ''));
  return addresses.length > 0 && !addresses.some(isBlockedHost);
};

/**
 * Parses ALERT_WEBHOOK_URLS. https only; http and loopback only for localhost testing.
 * Errors name the entry index, never the URL: Slack and Discord webhook URLs are secrets.
 */
export const parseWebhookUrls = (raw: string): string[] => {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length > MAX_WEBHOOK_URLS) throw new Error(`at most ${MAX_WEBHOOK_URLS} URLs`);
  return entries.map((entry, i) => {
    let u: URL;
    try {
      u = new URL(entry);
    } catch {
      throw new Error(`entry ${i + 1} is not a URL`);
    }
    if (u.username || u.password) throw new Error(`entry ${i + 1} must not carry credentials`);
    const loopback = LOOPBACK_HOSTS.has(u.hostname);
    if (u.protocol === 'http:' && !loopback) throw new Error(`entry ${i + 1} must use https (http only for localhost)`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`entry ${i + 1} must use https`);
    if (!loopback && isBlockedHost(u.hostname)) throw new Error(`entry ${i + 1} points at a private or reserved address`);
    return u.toString();
  });
};

/** Value of the signature header: sha256=<hex HMAC-SHA256 of "<timestamp>.<exact body>">, so a captured alert cannot be replayed later. */
export const signatureOf = (body: string, secret: string, timestamp: number): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/** Receiver side, for reference and tests: signature over "<timestamp>.<raw body>" and a timestamp within `toleranceS`. */
export const verifyAlertSignature = (rawBody: string, timestamp: string | null, signature: string | null, secret: string, nowMs: number, toleranceS = 300): boolean => {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > toleranceS) return false;
  const want = Buffer.from(signatureOf(rawBody, secret, Number(timestamp)));
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
};

export interface DeliverOptions {
  timeoutMs: number;
  secret?: string;
  attempts?: number;
  backoffMs?: number;
  resolve?: Resolve;
  now?: () => number; // ms
}

export interface DeliverResult {
  ok: boolean;
  attempts: number;
  status: number | null;
  error?: string;
}

const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** POSTs `body` to `url`, retrying timeouts, network errors, 408, 429 and 5xx with exponential backoff. */
export const deliver = async (url: string, body: string, o: DeliverOptions): Promise<DeliverResult> => {
  const attempts = o.attempts ?? 3;
  let last: DeliverResult = { ok: false, attempts: 0, status: null };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await Bun.sleep((o.backoffMs ?? 1000) * 2 ** (i - 1));
    // a fresh timestamp per attempt, so a late retry still passes the receiver's tolerance
    const timestamp = Math.floor((o.now ?? Date.now)() / 1000);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'SecretShopper-Alerts/1', [TIMESTAMP_HEADER]: String(timestamp) };
    if (o.secret) headers[SIGNATURE_HEADER] = signatureOf(body, o.secret, timestamp);
    try {
      // DNS rebinding: check what the name points at now. fetch resolves again, so this narrows the window, not closes it.
      if (!(await resolvesPublic(url, o.resolve))) return { ok: false, attempts: i + 1, status: null, error: 'BlockedAddress' };
      // manual: a redirect could point the signed body at an internal host
      const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs) });
      await res.body?.cancel();
      if (res.status >= 200 && res.status < 300) return { ok: true, attempts: i + 1, status: res.status };
      last = { ok: false, attempts: i + 1, status: res.status };
      if (!retryable(res.status)) return last;
    } catch (error) {
      last = { ok: false, attempts: i + 1, status: null, error: (error as Error).name };
    }
  }
  return last;
};
