import { createHash } from 'node:crypto';

// Sorted keys at every depth; arrays keep order. Must match web/src/lib/near/commitment.ts.
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
        )
      : v;

export const canonicalJson = (doc: unknown): string => JSON.stringify(sortKeys(doc));

/** Invoice id the agent sees: sha256 hex of the canonical JSON of the document. */
export const invoiceIdOf = (doc: unknown): string => createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex');
