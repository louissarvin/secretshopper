// Pure format checks shared by the API, tester and tests. No imports on purpose.

// nearcore rule: 2 to 64 chars, lowercase alnum, single separators (. - _) not at the ends.
const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isValidAccountId = (s: string): boolean => s.length >= 2 && s.length <= 64 && ACCOUNT_ID_RE.test(s);

export const HEX32_RE = /^[0-9a-f]{64}$/;
export const CUID_RE = /^[a-z0-9]{20,32}$/;
export const ED25519_PK_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** X-Shop header (v2/37 ADR-1): absent is `fallback`; anything but one valid account id is null. No case folding. */
export const parseShopHeader = (raw: unknown, fallback: string): string | null =>
  raw === undefined ? fallback : typeof raw === 'string' && isValidAccountId(raw) ? raw : null;
