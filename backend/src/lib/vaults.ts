import { createBudget } from './intents/quote.ts';

// Registered vaults for the workers (v2/37 section 5). The default vault (SHOP_CONTRACT_ID) comes first.
// No database import here: the loader comes from src/lib/registry.ts, so tests can import this module safely.

export interface RegisteredVault {
  companyId: string;
  shop: string;
  deployBlock: bigint;
  isDefault: boolean;
  testerEnabled: boolean;
}

const TTL_MS = 30_000;

/** Cached list of companies; `invalidate` after a registration so workers pick a new vault up at once. */
export interface RegistryRow {
  id: string;
  shopContractId: string;
  deployBlock: bigint;
  testerEnabled: boolean;
}

export const createRegistry = (defaultShop: string, load: () => Promise<RegistryRow[]>) => {
  let cache: { at: number; value: Promise<RegisteredVault[]> } | null = null;
  return {
    list(): Promise<RegisteredVault[]> {
      if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
      const value = load().then((rows) =>
        rows
          .map((r) => ({ companyId: r.id, shop: r.shopContractId, deployBlock: r.deployBlock, isDefault: r.shopContractId === defaultShop, testerEnabled: r.testerEnabled }))
          .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      );
      cache = { at: Date.now(), value };
      value.catch(() => (cache = null));
      return value;
    },
    invalidate(): void {
      cache = null;
    },
  };
};

// Uncached chain reads on public vault routes and registrations share this budget (NF-04).
export const chainBudget = createBudget(60, 60_000);

/** Up to `k` items from `list` starting at `start`, wrapping; `next` is where the following pick starts. */
export const pickRoundRobin = <T>(list: T[], start: number, k: number): { picked: T[]; next: number } => {
  if (!list.length || k <= 0) return { picked: [], next: 0 };
  const n = Math.min(k, list.length);
  const from = start % list.length;
  return { picked: Array.from({ length: n }, (_, i) => list[(from + i) % list.length]), next: (from + n) % list.length };
};
