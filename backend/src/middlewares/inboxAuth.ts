import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { INBOX_TOKEN_HASH, SHOP_CONTRACT_ID } from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { handleError } from '../utils/errorHandler.ts';

declare module 'fastify' {
  interface FastifyRequest {
    inboxShop?: string; // the vault this token serves
    inboxCompanyId?: string; // set for a per-company token; the env token resolves it through inboxCompanyId()
  }
}

const expected = Buffer.from(INBOX_TOKEN_HASH, 'hex');
// POST /company/inbox-token issues exactly this form; anything else is refused without a database lookup
export const COMPANY_TOKEN_RE = /^ssi_[A-Za-z0-9_-]{43}$/;

/**
 * The agent's bearer token. The env token (sha256 in INBOX_TOKEN_HASH, compared in constant time, no database)
 * serves the default vault; a per-company token (POST /company/inbox-token) serves its company. Else 401; 503 when a
 * well-formed company token cannot be checked because the database is down.
 */
export const inboxAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<true | FastifyReply> => {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return handleError(reply, 401, 'Invalid inbox token', 'INBOX_UNAUTHORIZED');
  const got = createHash('sha256').update(token, 'utf8').digest();
  if (got.length === expected.length && timingSafeEqual(got, expected)) {
    request.inboxShop = SHOP_CONTRACT_ID;
    return true;
  }
  if (!COMPANY_TOKEN_RE.test(token)) return handleError(reply, 401, 'Invalid inbox token', 'INBOX_UNAUTHORIZED');
  let company;
  try {
    // a unique-index lookup of the sha256 of a 256-bit random token: its timing tells an attacker nothing usable
    company = await prismaQuery.company.findUnique({ where: { inboxTokenHash: got.toString('hex') }, select: { id: true, shopContractId: true } });
  } catch (error) {
    // the token cannot be checked: unavailable, never accepted and never a 500
    return handleError(reply, 503, 'Inbox tokens cannot be checked right now', 'INBOX_UNAVAILABLE', error as Error);
  }
  if (!company) return handleError(reply, 401, 'Invalid inbox token', 'INBOX_UNAUTHORIZED');
  request.inboxShop = company.shopContractId;
  request.inboxCompanyId = company.id;
  return true;
};

/** The token's company id; null for the env token while the default vault is not registered yet. */
export const inboxCompanyId = async (request: FastifyRequest): Promise<string | null> =>
  request.inboxCompanyId ?? (await prismaQuery.company.findUnique({ where: { shopContractId: SHOP_CONTRACT_ID }, select: { id: true } }))?.id ?? null;
