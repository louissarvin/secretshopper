import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { handleError } from './errorHandler.ts';

import { CUID_RE, HEX32_RE, isValidAccountId } from './ids.ts';

export { CUID_RE, ED25519_PK_RE, HEX32_RE, isValidAccountId } from './ids.ts';

export const accountIdSchema = z.string().refine(isValidAccountId, 'invalid NEAR account id');
export const hex32Schema = z.string().regex(HEX32_RE, 'expected 64 lowercase hex chars');
export const cuidSchema = z.string().regex(CUID_RE, 'invalid id');
// u128 base units as a decimal string, no sign, no leading zeros
export const baseUnitsSchema = z.string().regex(/^(0|[1-9]\d{0,38})$/, 'expected a decimal integer string');
export const railSchema = z.enum(['Near', 'Intents']);
export const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

// Bounded JSON value: rejects deep or huge documents before they reach the DB.
export { jsonObjectSchema } from './intake.ts';

/** Parses `input` or replies 400 with the field paths that failed (never the values). */
export const parseOr400 = async <T>(
  schema: z.ZodType<T>,
  input: unknown,
  reply: FastifyReply
): Promise<{ ok: true; data: T } | { ok: false }> => {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))];
  await handleError(reply, 400, `Invalid input: ${fields.join(', ')}`, 'VALIDATION_ERROR', null, { fields });
  return { ok: false };
};
