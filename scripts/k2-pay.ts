/**
 * K2: the locked, armed vault pays a never-existing implicit account twice (16b §9, testnet per v2/19 §2).
 * Pass: payee balance = 2 x amount; vault NEAR drops by one storage deposit, not two (second is refunded).
 * Spends real tokens on mainnet. Env: NEAR_NETWORK, AGENT_VAULT_ID, AGENT_PRIVATE_KEY, USDC_CONTRACT_ID, K2_AMOUNT (default 10000 = 0.01).
 */
import { randomBytes } from 'node:crypto';
import { Account, KeyPair, keyToImplicitAddress, teraToGas, type KeyPairString } from 'near-api-js';
import { NEAR, provider, req, txUrl, view } from './lib/net.ts';

const VAULT = req('AGENT_VAULT_ID');
const TOKEN = req('USDC_CONTRACT_ID');
const AMOUNT = process.env.K2_AMOUNT || '10000';
if (!/^[1-9]\d*$/.test(AMOUNT)) throw new Error('K2_AMOUNT must be base units');

const status = await view<{ token_id: string; mode: string }>(VAULT, 'get_status');
if (status.token_id !== TOKEN) throw new Error(`vault token is ${status.token_id}, not ${TOKEN}`);
if (status.mode !== 'Armed') throw new Error(`vault must be Armed, is ${status.mode}`);

const agent = new Account(VAULT, provider, req('AGENT_PRIVATE_KEY') as KeyPairString);
const payee = keyToImplicitAddress(KeyPair.fromRandom('ed25519').getPublicKey());
const nearBalance = async () => (await provider.viewAccount({ accountId: VAULT })).amount;

const before = await nearBalance();
const txs: string[] = [];
for (let i = 0; i < 2; i++) {
  const out = await agent.callFunctionRaw({
    contractId: VAULT,
    methodName: 'pay',
    args: { invoice_id: randomBytes(32).toString('hex'), payee, amount: AMOUNT, rail: 'Near' },
    gas: teraToGas(80),
    deposit: 0n,
    waitUntil: 'FINAL',
  });
  txs.push(txUrl(out.transaction.hash));
}
const payeeBalance = await view<string>(TOKEN, 'ft_balance_of', { account_id: payee });
console.log(
  JSON.stringify(
    { network: NEAR.network, payee, payeeBalance, expected: (BigInt(AMOUNT) * 2n).toString(), vaultNearDelta: (before - (await nearBalance())).toString(), txs },
    null,
    2
  )
);
