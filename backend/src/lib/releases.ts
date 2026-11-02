import { prismaQuery } from './prisma.ts';

// Release ticks (v2/32) are recomputed from Invoice.deliverAt: every invoice, real or test, with one deliverAt is
// one tick. Shared by the tester (release, delivery proofs) and the public read route; reads the public schema only.

export interface ReleaseTick {
  releaseAt: Date;
  ids: string[]; // invoice ids, ascending (the Merkle leaf order)
}

/** Time after a tick before its set counts as closed, so a slow insert cannot land after the root is taken. */
export const RELEASE_SETTLE_MS = 60_000;

export const releaseAtNs = (d: Date): string => (BigInt(d.getTime()) * 1_000_000n).toString();

/** Ticks with since <= releaseAt <= until, oldest first, at most `limit` ticks. */
export const releaseTicks = async (companyId: string, since: Date, until: Date, limit: number): Promise<ReleaseTick[]> => {
  if (until < since) return [];
  const groups = await prismaQuery.invoice.groupBy({
    by: ['deliverAt'],
    where: { companyId, deliverAt: { gte: since, lte: until } },
    orderBy: { deliverAt: 'asc' },
    take: limit,
  });
  if (groups.length === 0) return [];
  const rows = await prismaQuery.invoice.findMany({
    where: { companyId, deliverAt: { in: groups.map((g) => g.deliverAt) } },
    orderBy: [{ deliverAt: 'asc' }, { invoiceId: 'asc' }],
    select: { invoiceId: true, deliverAt: true },
  });
  const byTick = new Map<number, string[]>(groups.map((g) => [g.deliverAt.getTime(), []]));
  for (const r of rows) byTick.get(r.deliverAt.getTime())?.push(r.invoiceId);
  // DB collation may not be bytewise; the tree wants byte order, which for lowercase hex is code-unit order
  return [...byTick].map(([t, ids]) => ({ releaseAt: new Date(t), ids: ids.sort() }));
};

/** Every invoice id released at exactly `releaseAt`, ascending. */
export const tickIds = async (companyId: string, releaseAt: Date): Promise<string[]> => {
  const rows = await prismaQuery.invoice.findMany({ where: { companyId, deliverAt: releaseAt }, select: { invoiceId: true } });
  return rows.map((r) => r.invoiceId).sort();
};
