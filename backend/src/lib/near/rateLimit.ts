// Recognizes provider rate limiting in what near-api-js and our FastNEAR tx API client throw.

/** Thrown by the FastNEAR tx API client when it gives up on a 429; carries the server's Retry-After. */
export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/** Retry-After header (seconds or an HTTP date) in ms; null when absent or unreadable. */
export const retryAfterMs = (header: string | null, nowMs = Date.now()): number | null => {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(at - nowMs, 0) : null;
};

/** True for a 429 or an exhausted failover list (`FailoverRpcError: Exceeded N providers`, usually after 429s). */
export const isRateLimited = (e: unknown): boolean => {
  if (e instanceof RateLimitedError) return true;
  const text = `${(e as { name?: string })?.name ?? ''} ${(e as { message?: string })?.message ?? String(e)}`;
  return /\b429\b|rate limit|too many requests|exceeded \d+ providers/i.test(text);
};
