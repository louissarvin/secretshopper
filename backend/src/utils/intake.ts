import { z } from 'zod';

// One intake normaliser for every inbox item, real or test (SS-B03). Pure: no DB or HTTP imports.

export const jsonObjectSchema = (maxBytes: number) =>
  z
    .record(z.string().max(128), z.unknown())
    .refine((v) => JSON.stringify(v).length <= maxBytes, `object larger than ${maxBytes} bytes`);

export const emailSchema = z
  .object({
    from_name: z.string().trim().min(1).max(200),
    from_email: z.email().max(254),
    subject: z.string().max(300),
    body: z.string().max(20_000),
  })
  .strict();

export const DOCUMENT_MAX_BYTES = 32 * 1024;
export const documentSchema = jsonObjectSchema(DOCUMENT_MAX_BYTES);

export type IntakeEmail = z.infer<typeof emailSchema>;

/** Same rule for both paths: the owner's form and the tester's generator. Throws on anything real intake would reject. */
export const normaliseIntake = (input: { document: unknown; email: unknown }): { document: Record<string, unknown>; email: IntakeEmail } => ({
  document: documentSchema.parse(input.document),
  email: emailSchema.parse(input.email),
});
