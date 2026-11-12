# 26 Vault v2 cost profile (2026-11-01)

Measured in the near-workspaces 0.24 sandbox (protocol 88, same as testnet) with `cd contracts/shop && cargo test --test costs -- --nocapture`. Prices: live `gas_price` on testnet and mainnet = 100,000,000 yocto/gas (0.0001 NEAR per Tgas, checked 2026-11-01); storage staking 10^19 yocto per byte (0.00001 NEAR per byte, refundable if freed).

| Method | Signer | Gas burnt | NEAR for gas | Vault storage added | NEAR locked for storage |
|:-|:-|-:|-:|-:|-:|
| `pay`, new payee (also registers on the token) | agent key | 9.38 Tgas | 0.00094 | 597 B | 0.0060 (+0.00125 token deposit) |
| `pay`, known payee | agent key | 7.26 Tgas | 0.00073 | 375 B | 0.0038 |
| `decline` | agent key | 2.10 Tgas | 0.00021 | 177 B | 0.0018 |
| `propose` | agent key | 2.45 Tgas | 0.00025 | 471 B | 0.0047 |
| `commit_batch` K=3, tlock ciphertexts in args (2.1.0: header and sha256 checked on chain) | tester key | 3.15 Tgas | 0.00032 | 1,039 B | 0.0104 |
| `reveal`, failed test with demotion and key swap | anyone | 3.91 Tgas | 0.00039 | 549 B | 0.0055 |
| `approve` (owner pays, registers) | owner wallet | 9.34 Tgas | 0.00093 | 288 B | 0.0029 |
| `add_payee` | owner wallet | 2.16 Tgas | 0.00022 | 178 B | 0.0018 |
| `freeze` | owner wallet | 2.55 Tgas | 0.00026 | -209 B | frees 0.0021 |
| `propose_key` / `accept_key` | owner / vendor | 1.92 / 2.64 Tgas | 0.00019 / 0.00026 | 37 / 168 B | small |

Contract code plus state after the run: 287,179 B (about 2.87 NEAR locked, almost all of it code).

## What a running company costs
Assume 20 agent payments a day to known payees, 4 batches of K=3 a day, 12 reveals a day:
- Gas: about 205 Tgas a day, about 0.02 NEAR a day, paid from the vault through the agent key allowance (pays) and by the tester and reveal senders.
- Storage: about 16.5 KB a day, about 0.165 NEAR a day locked in the vault, about 5 NEAR a month. **Storage, not gas, is the running cost.**

## Follow-ups (v3, not scheduled)
- Store a 32-byte hash of each decision and payment instead of the full struct, with the full record in the NEP-297 event; scoring needs only kind, payee hash, approved flag, time and key. Estimated about 60% less storage per decision.
- Let `withdraw_near` pay back storage freed by pruning revealed slots older than a retention window.

## Global contract by hash (contract 2.1.0, measured 2026-11-03 with `bun scripts/global-vault.ts`)
| | Classic deploy | NEP-591 global by hash |
|:-|-:|-:|
| One-time publish (burnt, not refundable) | 0 | 29.03 NEAR for 290,230 B (10x storage rate, docs.near.org/smart-contracts/global-contracts) |
| Vault storage after init | 290,770 B | 572 B |
| NEAR locked per vault | 2.91 | 0.006 |
| Owner cost to open a vault (incl. 0.5 NEAR float) | about 3.4 NEAR | 0.61 NEAR |
| Keys the vault ever holds | one full-access key until the lock tx | none |

Break-even from the 11th vault. Every vault's `view_account` shows `global_contract_hash`, so verifying the code is one RPC call instead of rebuilding per vault. The by-hash variant is immutable; the by-account-id variant was rejected because its publisher could swap every vault's code.

Testnet: the owner and vendor accounts hold about 11.8 NEAR, short of the 29.0 NEAR publish. Testnet stays on the classic `shop2` until it is funded; the demo and `global-vault.ts` prove the path on a local sandbox.
