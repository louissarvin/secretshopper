import { fetchTransactions, listSignedCallHashes } from './events.ts';
import { vaultChain } from './vaultChain.ts';
import type { ReputationReads, SignedCall, VaultScorecard, VaultStatus } from '../reputation.ts';

// Chain reads for buildReputation: the vendor's signed calls through the FastNEAR tx API, vault state through RPC views.

const MAX_SIGNER_ROWS = 600; // three pages of the vendor's own txs

const methodsOf = (actions: unknown[] | undefined): string[] =>
  (actions ?? []).flatMap((a) => {
    const fc = a && typeof a === 'object' ? (a as { FunctionCall?: { method_name?: unknown } }).FunctionCall : undefined;
    return typeof fc?.method_name === 'string' ? [fc.method_name] : [];
  });

export const reputationReads: ReputationReads = {
  async signedCalls(vendorId) {
    const { hashes, truncated } = await listSignedCallHashes(vendorId, MAX_SIGNER_ROWS);
    const calls: SignedCall[] = (await fetchTransactions(hashes))
      .filter((t) => t.transaction.signer_id === vendorId && typeof t.transaction.receiver_id === 'string')
      .map((t) => ({ receiverId: t.transaction.receiver_id!, methods: methodsOf(t.transaction.actions) }));
    return { calls, truncated };
  },
  globalCodeHash: async (accountId) => (await vaultChain.account(accountId))?.globalCodeHash ?? null,
  status: (vaultId) => vaultChain.view<VaultStatus>(vaultId, 'get_status'),
  scorecard: (vaultId) => vaultChain.view<VaultScorecard>(vaultId, 'get_scorecard'),
};
