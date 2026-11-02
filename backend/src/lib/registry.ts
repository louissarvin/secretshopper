import { SHOP_CONTRACT_ID } from '../config/main-config.ts';
import { prismaQuery } from './prisma.ts';
import { createRegistry } from './vaults.ts';

/** The API process's vault registry (workers and registration). */
export const registry = createRegistry(SHOP_CONTRACT_ID, () =>
  prismaQuery.company.findMany({ select: { id: true, shopContractId: true, deployBlock: true, testerEnabled: true }, orderBy: { createdAt: 'asc' } })
);
