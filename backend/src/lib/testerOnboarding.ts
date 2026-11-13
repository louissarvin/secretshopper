import cron from 'node-cron';
import { checkTesterKey } from './proof/testerKey.ts';
import type { VaultChain } from './vault/plan.ts';

// Tester opt-in for a self-serve vault. Chain and counts come in through deps.

// `M H * * *` only, so a vault commits at most hourly; the contract's batch_interval still decides when a batch is due
const COMMIT_CRON_RE = /^([0-5]?\d) ([0-9*,/-]+) \* \* \*$/;
export const isCommitCron = (s: string): boolean => {
  const m = COMMIT_CRON_RE.exec(s);
  return !!m && Number(m[1]) <= 59 && cron.validate(s);
};

export interface EnableDeps {
  chain: VaultChain;
  shop: string;
  publicKey: string | null; // companies.testerPublicKey, written by the tester's provisioner
  vendorCount: number;
  enabledOthers: number; // enabled non-default companies other than this one
  minAllowanceYocto: bigint;
  maxBatchSize: number;
  maxVaults: number;
}

export type EnableResult = { ok: true; signerId: string } | { ok: false; status: 409 | 422; code: string; message: string };

export const checkEnable = async (d: EnableDeps): Promise<EnableResult> => {
  if (!d.publicKey) return { ok: false, status: 422, code: 'provisioning', message: 'The tester key is not provisioned yet; retry within a minute' };
  const [status, policy] = await Promise.all([
    d.chain.view<{ owner_id: string }>(d.shop, 'get_status'),
    d.chain.view<{ batch_size: number }>(d.shop, 'get_policy'),
  ]);
  if (!status || !policy) return { ok: false, status: 422, code: 'NOT_A_VAULT', message: 'The vault views are not readable' };
  const key = checkTesterKey(await d.chain.accessKeys(status.owner_id), d.publicKey, d.shop, d.minAllowanceYocto);
  if (!key.ok) return { ok: false, status: 422, code: key.code, message: `The tester key on ${status.owner_id} is not usable: ${key.code}` };
  if (d.vendorCount < 1) return { ok: false, status: 422, code: 'no_vendors', message: 'Add at least one vendor first; lures imitate your vendors' };
  if (policy.batch_size > d.maxBatchSize) return { ok: false, status: 422, code: 'policy_unsupported', message: `batch_size ${policy.batch_size} is above the tester's limit of ${d.maxBatchSize}` };
  if (d.enabledOthers >= d.maxVaults) return { ok: false, status: 409, code: 'TESTER_FULL', message: 'The tester serves no more vaults right now' };
  return { ok: true, signerId: status.owner_id };
};
