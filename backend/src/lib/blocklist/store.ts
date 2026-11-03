import { prismaQuery } from '../prisma.ts';
import type { EvidenceKind } from './evidence.ts';

// public.blocklist_entries. Inserts are idempotent on (accountId, evidenceTx); nothing updates or deletes rows.

export type ReporterKind = 'owner' | 'agent' | 'tester';

export const entrySelect = {
  id: true,
  accountId: true,
  reason: true,
  evidenceTx: true,
  evidenceKind: true,
  reporterKind: true,
  reporterId: true,
  vault: true,
  verified: true,
  createdAt: true,
} as const;

export interface NewEntry {
  accountId: string;
  reason: string;
  evidenceTx: string;
  evidenceKind: EvidenceKind;
  reporterKind: ReporterKind;
  reporterId: string;
  vault: string;
}

const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';

/** Only call after verifyEvidence accepted the tx. `created` is false when the same account and tx were already listed. */
export const recordEntry = async (e: NewEntry) => {
  const key = { accountId_evidenceTx: { accountId: e.accountId, evidenceTx: e.evidenceTx } };
  const existing = await prismaQuery.blocklistEntry.findUnique({ where: key, select: entrySelect });
  if (existing) return { created: false, entry: existing };
  try {
    return { created: true, entry: await prismaQuery.blocklistEntry.create({ data: { ...e, verified: true }, select: entrySelect }) };
  } catch (error) {
    // a concurrent report of the same evidence won the insert
    if (!isUniqueViolation(error)) throw error;
    return { created: false, entry: (await prismaQuery.blocklistEntry.findUnique({ where: key, select: entrySelect }))! };
  }
};

export const MAX_ENTRIES_PER_ACCOUNT = 50;

/** Entries for an account; with `vaults`, only evidence from those vaults (an agent's trusted set, ADR-6). */
export const entriesFor = (accountId: string, vaults?: string[]) =>
  prismaQuery.blocklistEntry.findMany({
    where: { accountId, ...(vaults ? { vault: { in: vaults } } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_ENTRIES_PER_ACCOUNT,
    select: entrySelect,
  });

/** Newest first; `before` is the id of the last entry of the previous page. */
export const listEntries = async (limit: number, before?: string) => {
  const rows = await prismaQuery.blocklistEntry.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
    select: entrySelect,
  });
  return { items: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null };
};
