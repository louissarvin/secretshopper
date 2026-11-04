import type { FastifyReply } from 'fastify';
import { handleError, handleValidationError } from './errorHandler.ts';

/** Presence check (starter API). Routes follow it with a zod schema for shape. */
export const validateRequiredFields = async (
  body: Record<string, unknown> | null | undefined,
  fields: string[],
  reply: FastifyReply
): Promise<true | FastifyReply> => {
  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
    return handleError(reply, 400, 'Request body is empty', 'VALIDATION_ERROR');
  }
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  return missing.length > 0 ? handleValidationError(reply, missing) : true;
};
