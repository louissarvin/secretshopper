import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type RouteOptions } from 'fastify';
import FastifyCors from '@fastify/cors';
import FastifyRateLimit from '@fastify/rate-limit';
import { CORS_ORIGINS, TRUST_PROXY } from './config/main-config.ts';
import { hostedReadOnly, readOnlyAllows } from './config/hosted.ts';
import { prismaQuery } from './lib/prisma.ts';
import { handleError } from './utils/errorHandler.ts';
import { authRoutes } from './routes/authRoutes.ts';
import { companyRoutes } from './routes/companyRoutes.ts';
import { vendorRoutes } from './routes/vendorRoutes.ts';
import { vendorConsoleRoutes } from './routes/vendorConsoleRoutes.ts';
import { invoiceRoutes } from './routes/invoiceRoutes.ts';
import { inboxRoutes } from './routes/inboxRoutes.ts';
import { testRoutes } from './routes/testRoutes.ts';
import { proposalRoutes } from './routes/proposalRoutes.ts';
import { publicRoutes } from './routes/publicRoutes.ts';
import { vaultRoutes } from './routes/vaultRoutes.ts';
import { insightRoutes } from './routes/insightRoutes.ts';
import { blocklistInboxRoutes, blocklistPublicRoutes, blocklistRoutes } from './routes/blocklistRoutes.ts';
import { testerCompanyRoutes, testerPublicRoutes } from './routes/testerRoutes.ts';

const plainError = (reply: FastifyReply, statusCode: number, code: string, message: string) =>
  reply.code(statusCode).send({ success: false, error: { code, message }, data: null, timestamp: new Date().toISOString() });

/** Builds the API without listening, so tests can use fastify.inject. */
export const buildApp = async (opts: { onRoute?: (route: RouteOptions) => void } = {}): Promise<FastifyInstance> => {
  const readOnly = hostedReadOnly();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info', redact: ['req.headers.authorization'] },
    trustProxy: TRUST_PROXY, // only behind a known proxy, else every client shares its IP for rate limits
    bodyLimit: 64 * 1024,
  });
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute); // tests read every route's preHandlers

  // Must be awaited before routes so per-route config.rateLimit applies.
  await app.register(FastifyRateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(FastifyCors, {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Shop'], // X-Shop selects the vault on owner and vendor routes
  });

  if (readOnly) {
    app.addHook('onRequest', async (request, reply) => {
      if (!readOnlyAllows(request.method, request.routeOptions.url)) return plainError(reply, 403, 'READ_ONLY_DEMO', 'This hosted demo is read-only');
    });
  }

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler(async (err: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    // no DB write for floods of 429s
    if (status === 429) return plainError(reply, 429, 'RATE_LIMITED', 'Too many requests');
    if (status < 500) return handleError(reply, status, err.code?.startsWith('FST_') ? err.message : 'Bad request', err.code || 'BAD_REQUEST');
    return handleError(reply, 500, 'Internal server error', 'INTERNAL_ERROR', err);
  });
  app.setNotFoundHandler(async (_request, reply) => plainError(reply, 404, 'NOT_FOUND', 'Route not found'));

  app.get('/', async (_request, reply) => reply.code(200).send({ success: true, error: null, data: { service: 'secret-shopper-api' } }));
  app.get('/health', async (_request, reply) => reply.code(200).send({ success: true, error: null, data: { status: 'ok' } }));
  app.get('/ready', async (_request, reply) => {
    try {
      await prismaQuery.$queryRaw`SELECT 1`;
      return reply.code(200).send({ success: true, error: null, data: { status: 'ready', db: 'ok' } });
    } catch {
      return plainError(reply, 503, 'NOT_READY', 'Database unavailable');
    }
  });

  app.register(publicRoutes, { prefix: '/public' });
  app.register(vaultRoutes, { prefix: '/public' });
  app.register(insightRoutes, { prefix: '/public' });
  app.register(blocklistPublicRoutes, { prefix: '/public' });
  app.register(testerPublicRoutes, { prefix: '/public' });
  if (readOnly) return app;

  app.register(authRoutes, { prefix: '/auth' });
  app.register(companyRoutes, { prefix: '/company' });
  app.register(vendorRoutes, { prefix: '/vendors' });
  app.register(vendorConsoleRoutes, { prefix: '/vendor' });
  app.register(invoiceRoutes, { prefix: '/invoices' });
  app.register(inboxRoutes, { prefix: '/inbox' });
  app.register(testRoutes, { prefix: '/tests' });
  app.register(proposalRoutes, { prefix: '/proposals' });
  app.register(blocklistRoutes, { prefix: '/blocklist' });
  app.register(blocklistInboxRoutes, { prefix: '/inbox' });
  app.register(testerCompanyRoutes, { prefix: '/company' });

  return app;
};
