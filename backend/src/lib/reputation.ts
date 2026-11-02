// Agent vendor reputation from chain alone: every vault where the vendor signed accept_key, kept only if the vault runs
// the configured global code and still names this vendor. Pure: reads come in through `ReputationReads`.

export const MAX_VAULTS = 50;

export interface SignedCall {
  receiverId: string;
  methods: string[];
}

export interface ReputationReads {
  /** Function calls the vendor signed, newest first, and whether the scan stopped at its cap. */
  signedCalls(vendorId: string): Promise<{ calls: SignedCall[]; truncated: boolean }>;
  globalCodeHash(accountId: string): Promise<string | null>; // null when the account is missing or runs no global code
  status(vaultId: string): Promise<VaultStatus | null>;
  scorecard(vaultId: string): Promise<VaultScorecard | null>;
}

export interface VaultStatus {
  mode: string;
  owner_id: string;
  vendor_id: string;
  agent_key: string | null;
  armed_at: string;
  version: string;
}

export interface VaultScorecard {
  stats: { passed: number; failed: number; failed_contained: number; ignored?: number; unanswered: number; demotions: number };
  score_bps: number | null;
  pending: number;
}

export interface VaultReputation {
  vaultId: string;
  ownerId: string;
  ownedByVendor: boolean;
  mode: string;
  version: string;
  agentKey: string | null;
  armedAt: string | null;
  demotions: number;
  scorecard: VaultScorecard;
}

export interface Reputation {
  vendorId: string;
  vaults: VaultReputation[];
  aggregate: {
    vaults: number;
    distinctOwners: number;
    passed: number;
    failed: number; // failed + failed_contained
    failedContained: number;
    ignored: number;
    unanswered: number;
    scoreBps: number | null; // pooled like get_scorecard: passed / (passed + failed + failed_contained + ignored)
    demotions: number;
  };
  caveat: string;
  truncated: { txs: boolean; vaults: boolean };
}

export const CAVEAT = 'a vendor can test itself on a vault it also owns; see distinctOwners and owners per vault';

const iso = (ns: string) => (BigInt(ns) > 0n ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : null);

export const buildReputation = async (vendorId: string, codeHash: string, r: ReputationReads): Promise<Reputation> => {
  const { calls, truncated: txTruncated } = await r.signedCalls(vendorId);
  const candidates = [...new Set(calls.filter((c) => c.methods.includes('accept_key')).map((c) => c.receiverId))];
  const checked = candidates.slice(0, MAX_VAULTS);

  const vaults = (
    await Promise.all(
      checked.map(async (vaultId): Promise<VaultReputation | null> => {
        if (!codeHash || (await r.globalCodeHash(vaultId)) !== codeHash) return null;
        const [status, scorecard] = await Promise.all([r.status(vaultId), r.scorecard(vaultId)]);
        // accept_key signed by the vendor proves nothing if the vault now names someone else
        if (!status || !scorecard || status.vendor_id !== vendorId) return null;
        return {
          vaultId,
          ownerId: status.owner_id,
          ownedByVendor: status.owner_id === vendorId,
          mode: status.mode,
          version: status.version,
          agentKey: status.agent_key,
          armedAt: iso(status.armed_at),
          demotions: scorecard.stats.demotions,
          scorecard,
        };
      })
    )
  ).filter((v): v is VaultReputation => v !== null);

  const sum = (f: (v: VaultReputation) => number) => vaults.reduce((n, v) => n + f(v), 0);
  const passed = sum((v) => v.scorecard.stats.passed);
  const failedPlain = sum((v) => v.scorecard.stats.failed);
  const failedContained = sum((v) => v.scorecard.stats.failed_contained);
  const ignored = sum((v) => v.scorecard.stats.ignored ?? 0);
  const scored = passed + failedPlain + failedContained + ignored;
  return {
    vendorId,
    vaults,
    aggregate: {
      vaults: vaults.length,
      distinctOwners: new Set(vaults.map((v) => v.ownerId)).size,
      passed,
      failed: failedPlain + failedContained,
      failedContained,
      ignored,
      unanswered: sum((v) => v.scorecard.stats.unanswered),
      scoreBps: scored ? Math.floor((passed * 10_000) / scored) : null,
      demotions: sum((v) => v.demotions),
    },
    caveat: CAVEAT,
    truncated: { txs: txTruncated, vaults: candidates.length > MAX_VAULTS },
  };
};
