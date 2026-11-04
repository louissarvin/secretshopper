import type { FastifyReply } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { createLogger, errFields } from './logger.ts';
import { hostedReadOnly } from '../config/hosted.ts';

const log = createLogger('http');

interface ErrorContext {
  [key: string]: unknown;
}

interface ErrorResponse {
  success: false;
  error: { code: string; message: string; [detail: string]: unknown };
  data: null;
  timestamp: string;
}

/**
 * Logs to the DB and stdout, then replies with the standard error shape.
 * Never sends stacks or internal error messages to the client, in any environment.
 */
export const handleError = async (
  reply: FastifyReply,
  statusCode: number,
  message: string,
  errorCode: string,
  originalError: Error | null = null,
  context: ErrorContext | null = null,
  details: ErrorContext | null = null // client-safe extras inside `error`, e.g. field errors; never internal state
): Promise<FastifyReply> => {
  const request = reply.request;
  const userId = (request as { user?: { id: string } }).user?.id || null;
  const path = request.routeOptions?.url || request.url.split('?')[0];

  // the hosted demo's database role is read-only, so its errors go to stdout only
  if (!hostedReadOnly()) {
    prismaQuery.errorLog
      .create({
        data: {
          errorCode,
          message,
          statusCode,
          stack: originalError?.stack || null,
          context: context ? JSON.stringify(context) : null,
          userId,
          method: request.method,
          path,
          userAgent: request.headers['user-agent'] || null,
          ip: request.ip || null,
        },
      })
      .catch((dbError: unknown) => log.error('failed to persist error log', errFields(dbError)));
  }

  const fields = { reqId: request.id, statusCode, errorCode, method: request.method, path, userId, context };
  if (statusCode >= 500) log.error(message, { ...fields, ...(originalError ? errFields(originalError) : {}) });
  else log.warn(message, { ...fields, ...(originalError ? { cause: originalError.message } : {}) });

  const response: ErrorResponse = {
    success: false,
    error: { ...details, code: errorCode, message },
    data: null,
    timestamp: new Date().toISOString(),
  };
  return reply.code(statusCode).send(response);
};

export const handleValidationError = (reply: FastifyReply, missingFields: string[]): Promise<FastifyReply> =>
  handleError(reply, 400, `Missing required fields: ${missingFields.join(', ')}`, 'VALIDATION_ERROR', null, { missingFields });

export const handleNotFoundError = (reply: FastifyReply, resource: string): Promise<FastifyReply> =>
  handleError(reply, 404, `${resource} not found`, 'NOT_FOUND', null, { resource });

export const handleUnauthorizedError = (reply: FastifyReply, reason: string = 'Unauthorized'): Promise<FastifyReply> =>
  handleError(reply, 401, reason, 'UNAUTHORIZED');

export const handleForbiddenError = (reply: FastifyReply, reason: string = 'Forbidden'): Promise<FastifyReply> =>
  handleError(reply, 403, reason, 'FORBIDDEN');

export const handleConflictError = (reply: FastifyReply, reason: string): Promise<FastifyReply> =>
  handleError(reply, 409, reason, 'CONFLICT');

export const handleDatabaseError = (reply: FastifyReply, operation: string, originalError: Error): Promise<FastifyReply> =>
  handleError(reply, 500, `Database error during ${operation}`, 'DATABASE_ERROR', originalError, { operation });

export const handleServerError = (reply: FastifyReply, originalError: Error): Promise<FastifyReply> =>
  handleError(reply, 500, 'Internal server error', 'INTERNAL_ERROR', originalError);

export const handleUpstreamError = (reply: FastifyReply, what: string, originalError: Error): Promise<FastifyReply> =>
  handleError(reply, 502, `${what} is unavailable`, 'UPSTREAM_ERROR', originalError);
