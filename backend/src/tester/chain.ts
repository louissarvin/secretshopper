import { Account, getTransactionLastResult, nearToYocto, teraToGas, type Provider } from 'near-api-js';
import { AccountDoesNotExistError } from 'near-api-js/rpc-errors';
import type { KeyPairString } from 'near-api-js';
import type { ChainSlotArg } from './slots.ts';
import type { DeliveryArg } from '../lib/near/shop.ts';

type Outcome = Awaited<ReturnType<Account['callFunctionRaw']>>;

/** Calls signed by the owner's FC key (commit_batch, reveal, release, prove_delivery). Config-free so the local demo can drive it. */
export const createTesterChain = (o: { tester: Account; shopId: string; commitTgas: number; revealTgas: number; releaseTgas?: number }) => ({
  // ciphertexts ride in the same call so they stay in the tx args forever; the contract stores only their sha256
  commitBatchTx: async (slots: ChainSlotArg[], ciphertexts: string[]): Promise<{ txHash: string; firstSlot: number; outcome: Outcome }> => {
    if (slots.length !== ciphertexts.length) throw new Error('one ciphertext per slot');
    const outcome = await o.tester.callFunctionRaw({
      contractId: o.shopId,
      methodName: 'commit_batch',
      args: { slots, ciphertexts },
      gas: teraToGas(o.commitTgas),
      deposit: 0n,
      waitUntil: 'FINAL',
    });
    return { txHash: outcome.transaction.hash, firstSlot: Number(getTransactionLastResult(outcome)), outcome };
  },
  // delivery: proof that the lure was in an acked release; the contract reads it only on the Unanswered path
  revealTx: async (
    slotId: number,
    salt: string,
    payee: string,
    invoiceId: string,
    receiptHash: string,
    delivery?: DeliveryArg
  ): Promise<{ txHash: string; status: string; outcome: Outcome }> => {
    const outcome = await o.tester.callFunctionRaw({
      contractId: o.shopId,
      methodName: 'reveal',
      args: { slot_id: slotId, salt, payee, invoice_id: invoiceId, receipt_hash: receiptHash, ...(delivery ? { delivery } : {}) },
      gas: teraToGas(o.revealTgas),
      deposit: 0n,
      waitUntil: 'FINAL',
    });
    return { txHash: outcome.transaction.hash, status: String(getTransactionLastResult(outcome)), outcome };
  },
  /** Upgrades an Unanswered slot to Ignored with a delivery proof (permissionless on chain, V23-02). */
  proveDeliveryTx: async (slotId: number, delivery: DeliveryArg): Promise<{ txHash: string; status: string; outcome: Outcome }> => {
    const outcome = await o.tester.callFunctionRaw({
      contractId: o.shopId,
      methodName: 'prove_delivery',
      args: { slot_id: slotId, delivery },
      gas: teraToGas(o.releaseTgas ?? 30),
      deposit: 0n,
      waitUntil: 'FINAL',
    });
    return { txHash: outcome.transaction.hash, status: String(getTransactionLastResult(outcome)), outcome };
  },
  /** Posts the Merkle root over every invoice id released at `releaseAtNs` (once per tick). */
  releaseTx: async (releaseAtNs: string, root: string, count: number): Promise<{ txHash: string; outcome: Outcome }> => {
    const outcome = await o.tester.callFunctionRaw({
      contractId: o.shopId,
      methodName: 'release',
      args: { release_at: releaseAtNs, root, count },
      gas: teraToGas(o.releaseTgas ?? 30),
      deposit: 0n,
      waitUntil: 'FINAL',
    });
    return { txHash: outcome.transaction.hash, outcome };
  },
});

export type TesterChain = ReturnType<typeof createTesterChain>;

/**
 * Pulls a failed test's tokens back to the vault: the funder creates the implicit payee with a little NEAR,
 * then the payee (whose key only the tester holds) sends its full token balance to the vault.
 * Returns the sweep tx hash, or null when there is nothing to sweep.
 */
export const createSweeper = (o: { funder: Account; provider: Provider; tokenId: string; shopId: string; fundNear: string }) =>
  async (payee: string, payeeSecret: string, slotIndex: number): Promise<string | null> => {
    const balance = BigInt(((await o.provider.callFunction({ contractId: o.tokenId, method: 'ft_balance_of', args: { account_id: payee } })) as string) ?? '0');
    if (balance === 0n) return null;
    let exists = true;
    try {
      await o.provider.viewAccount({ accountId: payee });
    } catch (error) {
      if (!(error instanceof AccountDoesNotExistError)) throw error;
      exists = false;
    }
    if (!exists) await o.funder.transfer({ receiverId: payee, amount: nearToYocto(o.fundNear as `${number}`) });
    const holder = new Account(payee, o.provider, payeeSecret as KeyPairString);
    const outcome = await holder.callFunctionRaw({
      contractId: o.tokenId,
      methodName: 'ft_transfer',
      args: { receiver_id: o.shopId, amount: balance.toString(), memo: `shop:sweep:${slotIndex}` },
      deposit: 1n, // NEP-141 requires exactly 1 yocto
      gas: teraToGas(30),
      waitUntil: 'FINAL',
    });
    return outcome.transaction.hash;
  };
