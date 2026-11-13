import { z } from 'zod';
import { readVault } from './vault/view.ts';
import type { VaultChain } from './vault/plan.ts';

// Self-serve vault registration. Pure: chain, tx API and database come in through deps.

export interface RegistrationDeps {
  chain: VaultChain;
  codeHash: string;
  firstReceivedTx(accountId: string): Promise<{ hash: string; blockHeight: number } | null>;
  registered(shopId: string): Promise<boolean>;
  companiesOf(userId: string): Promise<number>;
  maxCompanies: number;
}

export type RegistrationResult =
  | { ok: true; vendorAccountId: string; deployBlock: bigint; createdTxHash: string }
  | { ok: false; status: 403 | 404 | 409 | 422 | 503; code: string; message: string };

const ftMetadata = z.object({ symbol: z.string().min(1).max(32), decimals: z.number().int().min(0).max(38) });

/** Checks in the design's order; the first failure wins. Never trusts a client deploy block. */
export const checkSelfServe = async (shopId: string, user: { id: string; wallet: string }, d: RegistrationDeps): Promise<RegistrationResult> => {
  const read = await readVault(d.chain, shopId, d.codeHash);
  if (read.kind === 'missing') return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Account not found' };
  if (read.kind === 'foreign') return { ok: false, status: 422, code: 'NOT_A_VAULT', message: 'Not a Secret Shopper vault: the account runs other code or was never initialized' };
  const status = read.vault.status as { owner_id?: unknown; vendor_id?: unknown; token_id?: unknown };
  if (status.owner_id !== user.wallet) return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Only the vault owner can register the company' };
  if (typeof status.vendor_id !== 'string' || typeof status.token_id !== 'string') return { ok: false, status: 422, code: 'NOT_A_VAULT', message: 'The vault status is not readable' };
  if (!ftMetadata.safeParse(await d.chain.view(status.token_id, 'ft_metadata')).success)
    return { ok: false, status: 422, code: 'TOKEN_UNSUPPORTED', message: `Token ${status.token_id} has no readable ft_metadata` };
  if (await d.registered(shopId)) return { ok: false, status: 409, code: 'CONFLICT', message: 'Company already registered' };
  if ((await d.companiesOf(user.id)) >= d.maxCompanies) return { ok: false, status: 409, code: 'COMPANY_LIMIT', message: `At most ${d.maxCompanies} companies per account` };
  const created = await d.firstReceivedTx(shopId);
  if (!created) return { ok: false, status: 503, code: 'VAULT_NOT_INDEXED', message: 'The vault is not indexed yet; retry in a few seconds' };
  // one block of margin, whatever the tx API's range inclusivity
  return { ok: true, vendorAccountId: status.vendor_id, deployBlock: BigInt(Math.max(created.blockHeight - 1, 0)), createdTxHash: created.hash };
};
