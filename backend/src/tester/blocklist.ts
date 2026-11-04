import type { EvidenceVerdict } from '../lib/blocklist/evidence.ts';
import type { NewEntry } from '../lib/blocklist/store.ts';
import type { Logger } from '../utils/logger.ts';

// After a Failed reveal the lure payee goes on the shared blocklist, with the reveal tx as evidence. The same on-chain
// check as the API's runs first, so a tester entry is never weaker than a reported one. Deps injected for tests.

export interface FailedReveal {
  slotIndex: number;
  payee: string;
  revealTxHash: string;
}

export interface BlocklistDeps {
  failedReveals(): Promise<FailedReveal[]>;
  listed(accountId: string, evidenceTx: string): Promise<boolean>;
  verify(accountId: string, evidenceTx: string): Promise<EvidenceVerdict>;
  record(e: NewEntry): Promise<{ created: boolean }>;
  reporterId: string;
  vault: string;
  log: Logger;
}

/** Records every Failed reveal not yet listed. A tx the indexer does not have yet is retried on the next run. */
export const blocklistFailedReveals = async (d: BlocklistDeps): Promise<number> => {
  let added = 0;
  for (const f of await d.failedReveals()) {
    try {
      if (await d.listed(f.payee, f.revealTxHash)) continue;
      const v = await d.verify(f.payee, f.revealTxHash);
      if (!v.ok) {
        d.log.warn('failed reveal not blocklisted yet', { slotIndex: f.slotIndex, txHash: f.revealTxHash, reason: v.reason });
        continue;
      }
      const { created } = await d.record({
        accountId: f.payee,
        reason: `Lure payee of test slot ${f.slotIndex} on ${d.vault}: the agent paid it and the reveal scored Failed.`,
        evidenceTx: f.revealTxHash,
        evidenceKind: v.kind,
        reporterKind: 'tester',
        reporterId: d.reporterId,
        vault: d.vault,
      });
      if (created) added++;
      d.log.info('lure payee blocklisted', { slotIndex: f.slotIndex, payee: f.payee, txHash: f.revealTxHash, created });
    } catch (error) {
      d.log.error('blocklist write failed', { slotIndex: f.slotIndex, error: (error as Error).message });
    }
  }
  return added;
};
