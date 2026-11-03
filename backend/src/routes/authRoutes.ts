import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { createNonce, verifyNep413 } from '../lib/near/auth.ts';
import { handleServerError, handleUnauthorizedError } from '../utils/errorHandler.ts';
import { accountIdSchema, ED25519_PK_RE, parseOr400 } from '../utils/validation.ts';
import { AUTH_CHALLENGE_TTL_MS, AUTH_MESSAGE, AUTH_RECIPIENT, JWT_EXPIRES_IN, JWT_SECRET } from '../config/main-config.ts';

const nonceSchema = z.object({ accountId: accountIdSchema }).strict();
const verifySchema = z
  .object({
    accountId: accountIdSchema,
    publicKey: z.string().regex(ED25519_PK_RE, 'expected an ed25519 public key'),
    signature: z.string().min(1).max(200),
    nonce: z.string().length(44), // base64 of 32 bytes
  })
  .strict();

const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const authRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post('/nonce', { config: authLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = await parseOr400(nonceSchema, request.body, reply);
    if (!parsed.ok) return;
    try {
      const nonce = createNonce();
      await prismaQuery.authChallenge.create({
        data: { nonce, accountId: parsed.data.accountId, expiresAt: new Date(Date.now() + AUTH_CHALLENGE_TTL_MS) },
      });
      return reply.code(200).send({ success: true, error: null, data: { message: AUTH_MESSAGE, recipient: AUTH_RECIPIENT, nonce } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  app.post('/verify', { config: authLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = await parseOr400(verifySchema, request.body, reply);
    if (!parsed.ok) return;
    const { accountId, publicKey, signature, nonce } = parsed.data;
    try {
      const challenge = await prismaQuery.authChallenge.findUnique({ where: { nonce } });
      if (!challenge || challenge.accountId !== accountId || challenge.usedAt || challenge.expiresAt < new Date()) {
        return handleUnauthorizedError(reply, 'Challenge expired or unknown');
      }
      const valid = await verifyNep413({ accountId, publicKey, signature, message: AUTH_MESSAGE, recipient: AUTH_RECIPIENT, nonceB64: nonce });
      if (!valid) return handleUnauthorizedError(reply, 'Signature verification failed');

      // single use: only one concurrent request can flip usedAt
      const consumed = await prismaQuery.authChallenge.updateMany({ where: { nonce, usedAt: null }, data: { usedAt: new Date() } });
      if (consumed.count !== 1) return handleUnauthorizedError(reply, 'Challenge already used');

      const user = await prismaQuery.user.upsert({
        where: { walletAddress: accountId },
        create: { walletAddress: accountId, lastSignIn: new Date() },
        update: { lastSignIn: new Date() },
      });
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: JWT_EXPIRES_IN as SignOptions['expiresIn'],
      });
      request.log.info({ accountId }, 'sign-in');
      return reply.code(200).send({ success: true, error: null, data: { token, accountId } });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  done();
};
