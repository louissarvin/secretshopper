import jwt from 'jsonwebtoken';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { JWT_SECRET } from '../config/main-config.ts';
import { handleError } from '../utils/errorHandler.ts';

interface JwtPayload {
  userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      walletAddress: string;
      nonce: string | null;
      lastSignIn: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };
  }
}

export const authMiddleware = async (request: FastifyRequest, reply: FastifyReply): Promise<true | FastifyReply> => {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return handleError(reply, 401, 'Missing or invalid authorization header', 'MISSING_AUTH_HEADER');
  }
  const token = authHeader.slice(7);
  if (!token) return handleError(reply, 401, 'Token not provided', 'TOKEN_MISSING');

  let authData: JwtPayload;
  try {
    // pin the algorithm so a forged "none"/RS header is rejected
    authData = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
  } catch (error) {
    return handleError(reply, 401, 'Invalid or expired token', 'INVALID_TOKEN', error as Error);
  }
  if (!authData || typeof authData.userId !== 'string' || !authData.userId) {
    return handleError(reply, 401, 'Invalid token payload', 'INVALID_TOKEN_PAYLOAD');
  }

  const user = await prismaQuery.user.findUnique({ where: { id: authData.userId } });
  if (!user) return handleError(reply, 401, 'User not found', 'USER_NOT_FOUND');

  request.user = user;
  return true;
};
