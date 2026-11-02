import { prismaQuery } from '../prisma.ts';
import { HEALTH_KINDS, type HealthKind } from './map.ts';
import type { EventStore, HealthState, HealthStore } from './runner.ts';

// Both live in ChainCursor (id, blockHeight BigInt), so no schema change: blockHeight holds the value, updatedAt the change time.
// alerts:<shop> holds the event cursor as a createdAt in ms, not a block height.

const putCursor = (id: string, value: bigint) =>
  prismaQuery.chainCursor.upsert({ where: { id }, create: { id, blockHeight: value }, update: { blockHeight: value }, select: { updatedAt: true } });

export const eventStore = (shop: string): EventStore => {
  const id = `alerts:${shop}`;
  return {
    loadCursor: async () => {
      const row = await prismaQuery.chainCursor.findUnique({ where: { id }, select: { blockHeight: true } });
      return row ? Number(row.blockHeight) : null;
    },
    saveCursor: async (ms) => {
      await putCursor(id, BigInt(ms));
    },
    newestCreatedAt: async () =>
      (await prismaQuery.contractEvent.findFirst({ where: { contractId: shop }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }))?.createdAt.getTime() ?? null,
    idsBetween: async (fromMs, toMs) =>
      (
        await prismaQuery.contractEvent.findMany({
          where: { contractId: shop, createdAt: { gte: new Date(fromMs), lte: new Date(toMs) } },
          select: { id: true, createdAt: true },
        })
      ).map((r) => ({ id: r.id, createdAt: r.createdAt.getTime() })),
    fetch: (fromMs, exclude, take, events) =>
      prismaQuery.contractEvent.findMany({
        where: { contractId: shop, event: { in: [...events] }, createdAt: { gte: new Date(fromMs) }, ...(exclude.length ? { id: { notIn: exclude } } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take,
        select: { id: true, txHash: true, blockHeight: true, blockTime: true, event: true, data: true, createdAt: true },
      }),
  };
};

export const healthStore = (shop: string): HealthStore => {
  const idOf = (kind: HealthKind) => `health:${shop}:${kind}`;
  return {
    load: async () => {
      const rows = await prismaQuery.chainCursor.findMany({ where: { id: { in: HEALTH_KINDS.map(idOf) } }, select: { id: true, blockHeight: true, updatedAt: true } });
      const out = new Map<HealthKind, HealthState>();
      for (const k of HEALTH_KINDS) {
        const r = rows.find((row) => row.id === idOf(k));
        if (r) out.set(k, { value: r.blockHeight, since: r.updatedAt });
      }
      return out;
    },
    save: async (kind, value) => (await putCursor(idOf(kind), value)).updatedAt,
  };
};
