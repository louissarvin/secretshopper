import type { AccountFacts, ToolDeps } from '../src/tools.ts';

export const NOW = Date.parse('2026-11-06T12:00:00Z');

// An approved, active, year-old payee with no contract: the preflight allows it.
export const establishedFacts = (id: string): AccountFacts => ({
  account_id: id,
  exists: true,
  hasContract: false,
  contract: null,
  code_history: { covered_hours: 24, existed_at_start: true, code_changed: false },
  first_seen_by_vault: '2026-09-01T00:00:00.000Z',
  first_tx_at: '2025-11-01T00:00:00.000Z',
  approved_payee: { label: 'Acme', active: true, active_at: '2026-01-01T00:00:00.000Z', removed_at: null },
});

// Deps that record every call; "no chain call" means this list stays empty. Preflight reads are views.
export const recorder = (over: Partial<ToolDeps> = {}) => {
  const calls: string[] = [];
  const audit: Record<string, unknown>[] = [];
  const touch = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}(${args.join(',')})`);
    return { ok: true };
  };
  const deps: ToolDeps = {
    getVendor: touch('getVendor'),
    accountFacts: async (id) => {
      calls.push(`accountFacts(${id})`);
      return establishedFacts(id);
    },
    spendLimits: async () => ({ max_per_payment: 2_000_000n, daily_cap: 5_000_000n, spent_24h: 0n }),
    reservedAccounts: ['shop.owner.testnet', 'usdc.testnet'],
    decline: touch('decline'),
    pay: touch('pay'),
    propose: touch('propose'),
    intentsEnabled: false,
    tokenDecimals: 6,
    audit: (msg, f) => audit.push({ msg, ...f }),
    nowMs: () => NOW,
    ...over,
  };
  const signed = () => calls.filter((c) => /^(pay|propose|decline)\(/.test(c));
  return { deps, calls, audit, signed };
};
