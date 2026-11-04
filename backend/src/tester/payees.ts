import { randomInt } from 'node:crypto';
import { Wallet } from 'ethers';
import { KeyPair, keyToImplicitAddress } from 'near-api-js';

// SS-B02 / B2: test payees mix NEAR implicit (64 hex) and eth-implicit (0x + 40 hex) shapes.

export type PayeeKind = 'near_implicit' | 'eth_implicit';
export interface TestPayee {
  payee: string;
  kind: PayeeKind;
  secret: string; // ed25519:... for NEAR implicit, 0x private key for eth-implicit
}

export const newTestPayee = (ethPercent: number, roll: () => number = () => randomInt(100)): TestPayee => {
  if (roll() < ethPercent) {
    const w = Wallet.createRandom();
    return { payee: w.address.toLowerCase(), kind: 'eth_implicit', secret: w.privateKey };
  }
  const kp = KeyPair.fromRandom('ed25519');
  return { payee: keyToImplicitAddress(kp.getPublicKey()), kind: 'near_implicit', secret: kp.toString() };
};
