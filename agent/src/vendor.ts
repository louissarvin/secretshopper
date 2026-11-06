// B11: the vault, not our database, says who may be paid. Vendor identity comes from the inbox; payees from get_payees.

export interface ChainPayee {
  account_id: string;
  label: string;
  active_at: string; // ns
  removed_at: string | null; // ns; delisting also waits payee_delay
}

/** Approved exactly while active_at <= t < removed_at, the contract's rule. */
export const isActive = (p: Pick<ChainPayee, 'active_at' | 'removed_at'>, nowNs: bigint): boolean =>
  BigInt(p.active_at) <= nowNs && (p.removed_at === null || nowNs < BigInt(p.removed_at));

const iso = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

export const createGetVendor =
  (o: { vendorRecord: (id: string) => Promise<unknown>; approvedPayees: () => Promise<ChainPayee[]>; nowMs: () => number }) =>
  async (vendorId: string): Promise<unknown> => {
    const record = (await o.vendorRecord(vendorId)) as Record<string, unknown> | null;
    if (!record) return null;
    const now = BigInt(o.nowMs()) * 1_000_000n;
    const { approvedPayees: _ignored, approved_payees: _ignored2, ...identity } = record;
    const payees = await o.approvedPayees();
    return {
      ...identity,
      approved_payees: payees
        .filter((p) => isActive(p, now))
        .map((p) => ({ account_id: p.account_id, label: p.label, ...(p.removed_at ? { delisted_at: iso(p.removed_at) } : {}) })),
      pending_payees: payees.filter((p) => BigInt(p.active_at) > now).map((p) => ({ account_id: p.account_id, label: p.label, active_at: iso(p.active_at) })),
      approved_payees_source: 'vault get_payees (on chain); pay only active approved payees',
    };
  };
