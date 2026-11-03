import type { FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { SHOP_CONTRACT_ID } from '../config/main-config.ts';
import { handleError, handleForbiddenError } from '../utils/errorHandler.ts';
import { parseShopHeader } from '../utils/ids.ts';

declare module 'fastify' {
  interface FastifyRequest {
    company?: { id: string; shopContractId: string; ownerUserId: string; vendorAccountId: string; isDefault: boolean };
  }
}

/** The vault an owner or vendor request is about: `X-Shop`, or SHOP_CONTRACT_ID when absent (v2/37 ADR-1). */
export const shopFromRequest = (request: FastifyRequest): { ok: true; shop: string } | { ok: false } => {
  // account ids are lowercase already: no normalization, so an uppercase id is refused rather than guessed
  const shop = parseShopHeader(request.headers['x-shop'], SHOP_CONTRACT_ID);
  return shop ? { ok: true, shop } : { ok: false };
};

/** Run after authMiddleware: loads the selected vault's company and requires the caller to own it. */
export const requireCompanyOwner = async (request: FastifyRequest, reply: FastifyReply): Promise<true | FastifyReply> => {
  const sel = shopFromRequest(request);
  if (!sel.ok) return handleError(reply, 400, 'Invalid input: X-Shop', 'VALIDATION_ERROR', null, { fields: ['X-Shop'] });
  const company = await prismaQuery.company.findUnique({
    where: { shopContractId: sel.shop },
    select: { id: true, shopContractId: true, ownerUserId: true, vendorAccountId: true },
  });
  if (!company) return handleError(reply, 404, 'Company is not registered yet', 'COMPANY_NOT_FOUND');
  if (company.ownerUserId !== request.user?.id) return handleForbiddenError(reply, 'Only the company owner can do this');
  request.company = { ...company, isDefault: company.shopContractId === SHOP_CONTRACT_ID };
  return true;
};
