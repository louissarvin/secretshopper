# Costs

What it costs to run Secret Shopper, measured on the testnet vault `shop4.ss-owner-e9c3db.testnet` (contract 2.3.0) from public data only. Nothing here is estimated from gas tables: every NEAR figure is the `tokens_burnt` the chain recorded for a listed transaction, and every inference figure is the token usage in a published NEAR AI receipt times NEAR AI's list price.

Reproduce: `cd scripts && bun unit-cost.ts` (read-only, no keys, about 6 s). Add `--near-usd <price>` to fill the USD columns for NEAR amounts; this file leaves them empty on purpose, since no NEAR price is fetched. Sources: FastNEAR Transactions API for the vault's transactions, archival RPC for key balances and storage at past blocks, `docs/evidence/shop4.ss-owner-e9c3db.testnet.json` for the receipts, `GET https://cloud-api.near.ai/v1/model/list` for prices.

## Reading the numbers

- **A test lure costs about 0.0006 NEAR on chain and 0.007 USD of inference.** Inference dominates unless NEAR is above about 12 USD (0.00725 / 0.000586). Generation cost per lure ranged from 0.0048 to 0.0133 USD; over 90% of every completion was reasoning tokens.
- **A day of testing at the tester's default schedule** (one commit of 3 lures a day) costs 0.0019 NEAR and 0.022 USD. At the policy's maximum (a batch every 6 h) it is 4 times that.
- **A failure costs about 0.5 NEAR, nearly all of it two gas-key balances destroyed by DeleteKey.** Demotion deletes the armed key (0.2477 NEAR left on it) and the re-arm deletes the demoted key (0.2481 NEAR). The gas itself is under 0.0015 NEAR. This cost scales with `key_allowance` (0.25 NEAR on shop4); a smaller allowance makes failures cheaper but funds fewer agent transactions per key.
- **An agent decision costs about 0.0005 NEAR** from the agent's gas key: the decision transaction plus its share of the tick's ack. A 0.25 NEAR allowance covers roughly 470 decisions.
- **Storage is staked, not spent.** The vault holds about 14 KB (0.14 NEAR locked); each slot adds about 740 bytes (0.0074 NEAR) for as long as the vault keeps its record.

Limits of the data: 9 slots in 3 batches, 10 agent decisions and one failure. `prove_delivery` was never called on shop4, so it has no row. Drafts the tester rejected never get a published receipt, so their calls are not counted (the bundle's generation log lists none rejected for these batches). The agent's own model calls belong to the vendor and are not included.

## Measured output

Output of `bun unit-cost.ts`, 2026-11-12:

Vault `shop4.ss-owner-e9c3db.testnet` (testnet), read 2026-11-12T18:28:02.922Z at block 277399705. 49 successful txs to the vault (0 failed, excluded). Gas price now 100000000 yocto/gas (0.000100 NEAR per Tgas, `gas_price` RPC); the costs below are the tokens_burnt recorded at the time. NEAR in USD: not given (pass --near-usd).

### Cost per transaction type

tokens_burnt summed over the tx and every receipt. Payer: the account whose NEAR pays (agent txs burn the gas key balance, which the vault funded).

| Tx | Signed by | Count | Mean NEAR | Min | Max | Mean USD | Txs |
| :- | :- | -: | -: | -: | -: | -: | :- |
| `commit_batch` | owner (tester FC key) | 3 | 0.000339 | 0.000336 | 0.000341 | n/a | [CHBk4ikp](https://testnet.nearblocks.io/txns/CHBk4ikpvvHE2GmsmN6SMpGKcPJWgkvRS9VZWanX3Hn4) [HKDdoime](https://testnet.nearblocks.io/txns/HKDdoimehyCtuUZDYZEr5WueQtbKtogtm2a9e7Qjxtao) [AhRRJQ4B](https://testnet.nearblocks.io/txns/AhRRJQ4BiVMR4QbHSeK6e28HUJjPY8PBgCn82nq3mxJp) |
| `release` | owner (tester FC key) | 7 | 0.000218 | 0.000216 | 0.000219 | n/a | [2ngrcPLh](https://testnet.nearblocks.io/txns/2ngrcPLhV849RuM7BCBy2a2b8qcDKcTCptun9foMAfeQ) [FtzNLxWW](https://testnet.nearblocks.io/txns/FtzNLxWWXdrAShMX91r9hZiVXuMACB9kCtRu4XjhTvRr) [BmQNF4Qj](https://testnet.nearblocks.io/txns/BmQNF4QjBsgp4PaxKX9WAi1ifAnPuctLJWfpw6xxfp8X) [C3LEFRpn](https://testnet.nearblocks.io/txns/C3LEFRpn2gcZpX1TeA16MMLKs88w9g9daPv5htCM4RtK) [2tMfQvXH](https://testnet.nearblocks.io/txns/2tMfQvXH9shntTcY9kdBrkckNRTVTc67uf8s8KD36Teh) [87vdYNsi](https://testnet.nearblocks.io/txns/87vdYNsiVicEMMJPPEUPbxgBeYAxvKu1yWriN1Z4bqT) [3oDEe4WG](https://testnet.nearblocks.io/txns/3oDEe4WGg8CcnxaSAHhBjkmABpLygqgKPSBK8MxoAxy9) |
| `reveal` (gas only) | owner (tester FC key) | 9 | 0.000328 | 0.000252 | 0.000659 | n/a | [AACtRwHX](https://testnet.nearblocks.io/txns/AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az) [7xdzzw5N](https://testnet.nearblocks.io/txns/7xdzzw5NJqHak3Md4YzSbjYhbbqdkaPe7JVTxxzzFUm8) [BcKeoKWe](https://testnet.nearblocks.io/txns/BcKeoKWeyovKLbAy6ef5et6uHFwr3wbijx8tCrAJbZvD) [9VaXwD4a](https://testnet.nearblocks.io/txns/9VaXwD4av52yEru3TQPs4CjweWRWJfLQgMLPgaiacpMq) [CbtHvfzC](https://testnet.nearblocks.io/txns/CbtHvfzCoGLHC8PiW8ZUFJqtpqrjQoEUz8uS1xJzrv9b) [4qbbwgMK](https://testnet.nearblocks.io/txns/4qbbwgMKJK1Rp7ShQYDwF6sYmWXZSJ4f8o4GAQjDg6q4) [C7imZ1st](https://testnet.nearblocks.io/txns/C7imZ1st24avingL6JSfQ9wUcV3QAQUP79U6aERuJRJj) [DD17cLoc](https://testnet.nearblocks.io/txns/DD17cLocTdYz9P2yQQHLCRX516SXrJQfCceFRMJxZsvt) [Fphkvw3k](https://testnet.nearblocks.io/txns/Fphkvw3kTNi55Uybp1sgw9sAaefioyviMK1S9nxk1oPH) |
| `prove_delivery` | owner (tester FC key) | 0 | none on this vault |  |  |  |  |
| `ack` | agent gas key | 7 | 0.000220 | 0.000220 | 0.000221 | n/a | [EujJqhh2](https://testnet.nearblocks.io/txns/EujJqhh2gxW2PXWw2C7X5U1BoLqZTHM3ovMetQHkSr12) [DRch8gEJ](https://testnet.nearblocks.io/txns/DRch8gEJvmiWRZYxi23Q3hak7KazBWh8UEH9JB17gAeQ) [Anukjsgg](https://testnet.nearblocks.io/txns/AnukjsggPcAeMSMo12MiiuZF7tUzQqU2NHya9WJRnkfC) [J9iPNQ9h](https://testnet.nearblocks.io/txns/J9iPNQ9h4L59wp17onfJMq5D422DhJZUnRZp9x4XPHmo) [3Bow7ppr](https://testnet.nearblocks.io/txns/3Bow7pprHNL18LsxPjpB7B2L2zBbuUQC4hvxKMGKiynz) [7nRUDzCi](https://testnet.nearblocks.io/txns/7nRUDzCiKqWncccqYBUhoiRMt5kCFGBQfN5YqgwgZJpj) [7Mi2Mr5j](https://testnet.nearblocks.io/txns/7Mi2Mr5jHXcCY9EW3gmQxXD8g5uenTyUVLvuYVFfDHff) |
| `decline` | agent gas key | 7 | 0.000230 | 0.000229 | 0.000231 | n/a | [5PQGjSpY](https://testnet.nearblocks.io/txns/5PQGjSpYDDa2HcsJWmXcnGz7CP9nJVnKhsRDY4Lay9Af) [AY1q7JSr](https://testnet.nearblocks.io/txns/AY1q7JSrFJLSTyhRDgQ2VqqXj6hGG6f9ztf1gGEvddMy) [23WmweHM](https://testnet.nearblocks.io/txns/23WmweHMNUkSLKAaNja6SW7sL54mbmJx8uBRDH2Ghx4L) [BBn6W4dz](https://testnet.nearblocks.io/txns/BBn6W4dzigLNUeZgBg4kuZH5nNEZqe53mR5vvM9UikJK) [8J7AnWEt](https://testnet.nearblocks.io/txns/8J7AnWEtxgqZk4eSnQAoMZNF3kzRpUkzthvf7wUy44Gy) [2WkPUFDU](https://testnet.nearblocks.io/txns/2WkPUFDU4QRPnRMunxqmgjPcaJ6Xzs7mY55yyUBJnEqQ) [78krE6Y8](https://testnet.nearblocks.io/txns/78krE6Y8xmvan6xjW6fLzBz4jDpWAdXewvfG1fK6Zcce) |
| `pay` | agent gas key | 2 | 0.000934 | 0.000930 | 0.000938 | n/a | [2oNV2J4b](https://testnet.nearblocks.io/txns/2oNV2J4bPuQd9dvTU5NGWvv1pAs8KenW3QKtM2AZ5Vg2) [F7VXiPxg](https://testnet.nearblocks.io/txns/F7VXiPxgT9JpDJV3GoT48hLNN89U2X1v8wzWrTgUDqdw) |
| `propose` | agent gas key | 1 | 0.000270 | 0.000270 | 0.000270 | n/a | [ttouZsWm](https://testnet.nearblocks.io/txns/ttouZsWmHrBLieWjAH9wxaVHXR5ds8GQ9cKkjKkSawo) |
| `approve` | owner | 1 | 0.000914 | 0.000914 | 0.000914 | n/a | [HCnvjL49](https://testnet.nearblocks.io/txns/HCnvjL494xLxJeFz6DfrBepB7ASXV9u68AXPQqanuaAG) |
| `propose_key` | owner | 2 | 0.000200 | 0.000199 | 0.000201 | n/a | [3R8c796g](https://testnet.nearblocks.io/txns/3R8c796gSbfAN8iA3V1gEp5ZuSGQYFrE2cZL7nUBGXW3) [4ykUPr15](https://testnet.nearblocks.io/txns/4ykUPr159mT4XaxEpaBWTUeCFzmsyoXy34EKJq699g6A) |
| `accept_key` (gas only) | vendor | 2 | 0.000550 | 0.000521 | 0.000579 | n/a | [G9skjfnS](https://testnet.nearblocks.io/txns/G9skjfnS4doDNKYwa7a4ZkncrbbpCG4QQLE4MLLYceF4) [7JkEMjHL](https://testnet.nearblocks.io/txns/7JkEMjHLifQS5dXcR3rwfAu6ZmojFNwiUctaeuiJJtPu) |

Reveals by outcome: passed or void 0.000286 NEAR mean; Failed 0.000659 NEAR gas plus 0.247714 NEAR of gas-key balance destroyed by DeleteKey ([AACtRwHX](https://testnet.nearblocks.io/txns/AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az)).

### Gas-key balance destroyed by DeleteKey

A demotion and a re-arm each delete the agent's gas key; its unspent balance is burned in that receipt. Balance read with `view_access_key_list` one block before the tx. Each new key is funded with `key_allowance` = 0.250000 NEAR from the vault.

| Tx | Event | Key balance destroyed (NEAR) | Total tokens_burnt (NEAR) | Of which gas |
| :- | :- | -: | -: | -: |
| [G9skjfnS](https://testnet.nearblocks.io/txns/G9skjfnS4doDNKYwa7a4ZkncrbbpCG4QQLE4MLLYceF4) | accept_key: agent_armed | 0.000000 | 0.000521 | 0.000521 |
| [AACtRwHX](https://testnet.nearblocks.io/txns/AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az) | reveal: agent_demoted, agent_key_changed | 0.247714 | 0.248373 | 0.000659 |
| [7JkEMjHL](https://testnet.nearblocks.io/txns/7JkEMjHLifQS5dXcR3rwfAu6ZmojFNwiUctaeuiJJtPu) | accept_key: agent_armed | 0.248146 | 0.248725 | 0.000579 |

### Storage

The vault holds 14206 bytes now, staking 0.142060 NEAR at 0.010000 NEAR per KB (protocol `storage_amount_per_byte`). Staked, not burned: it stays locked in the vault. Policy reserve `min_near_float` 0.500000 NEAR on top.

| Tx | Bytes added |
| :- | -: |
| [CHBk4ikp](https://testnet.nearblocks.io/txns/CHBk4ikpvvHE2GmsmN6SMpGKcPJWgkvRS9VZWanX3Hn4) commit_batch | 1039 |
| [HKDdoime](https://testnet.nearblocks.io/txns/HKDdoimehyCtuUZDYZEr5WueQtbKtogtm2a9e7Qjxtao) commit_batch | 1039 |
| [AhRRJQ4B](https://testnet.nearblocks.io/txns/AhRRJQ4BiVMR4QbHSeK6e28HUJjPY8PBgCn82nq3mxJp) commit_batch | 1039 |
| [AACtRwHX](https://testnet.nearblocks.io/txns/AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az) reveal | 420 |
| [7xdzzw5N](https://testnet.nearblocks.io/txns/7xdzzw5NJqHak3Md4YzSbjYhbbqdkaPe7JVTxxzzFUm8) reveal | 416 |
| [BcKeoKWe](https://testnet.nearblocks.io/txns/BcKeoKWeyovKLbAy6ef5et6uHFwr3wbijx8tCrAJbZvD) reveal | 416 |
| [9VaXwD4a](https://testnet.nearblocks.io/txns/9VaXwD4av52yEru3TQPs4CjweWRWJfLQgMLPgaiacpMq) reveal | 416 |
| [CbtHvfzC](https://testnet.nearblocks.io/txns/CbtHvfzCoGLHC8PiW8ZUFJqtpqrjQoEUz8uS1xJzrv9b) reveal | 394 |
| [4qbbwgMK](https://testnet.nearblocks.io/txns/4qbbwgMKJK1Rp7ShQYDwF6sYmWXZSJ4f8o4GAQjDg6q4) reveal | 394 |
| [C7imZ1st](https://testnet.nearblocks.io/txns/C7imZ1st24avingL6JSfQ9wUcV3QAQUP79U6aERuJRJj) reveal | 243 |
| [DD17cLoc](https://testnet.nearblocks.io/txns/DD17cLocTdYz9P2yQQHLCRX516SXrJQfCceFRMJxZsvt) reveal | 416 |
| [Fphkvw3k](https://testnet.nearblocks.io/txns/Fphkvw3kTNi55Uybp1sgw9sAaefioyviMK1S9nxk1oPH) reveal | 0 |

Mean storage per slot (commit share + its reveal): 692 bytes, 0.006920 NEAR staked.

### Lure generation (NEAR AI)

Usage from the `usage` field of each published receipt in `docs/evidence/shop4.ss-owner-e9c3db.testnet.json`; prices from `GET https://cloud-api.near.ai/v1/model/list` (nano-USD per token at scale 9). Cached prompt tokens at the cache-read price.

| Slot | Model | Prompt | Cached | Completion | Of which reasoning | USD |
| -: | :- | -: | -: | -: | -: | -: |
| 0 | Qwen/Qwen3.8-27B-abliterated | 763 | 0 | 9810 | 9461 | 0.0133 |
| 1 | Qwen/Qwen3.8-27B-abliterated | 764 | 0 | 6871 | 6520 | 0.00931 |
| 2 | Qwen/Qwen3.8-27B-abliterated | 803 | 0 | 5252 | 4867 | 0.00712 |
| 3 | Qwen/Qwen3.8-27B-abliterated | 763 | 320 | 3592 | 3241 | 0.00487 |
| 4 | Qwen/Qwen3.8-27B-abliterated | 783 | 0 | 3536 | 3194 | 0.00480 |
| 5 | Qwen/Qwen3.8-27B-abliterated | 806 | 320 | 5610 | 5213 | 0.00760 |
| 7 | Qwen/Qwen3.8-27B-abliterated | 802 | 0 | 4152 | 3758 | 0.00564 |
| 8 | Qwen/Qwen3.8-27B-abliterated | 783 | 0 | 3944 | 3588 | 0.00536 |

Qwen/Qwen3.8-27B-abliterated: input 0.040, output 1.350, cache read 0.018 USD per million tokens.

Mean per lure: 0.00725 USD. Drafts the tester rejected are not published, so their calls are not counted (the bundle's gen_log lists 0 rejected).

### Per slot

Commit share = commit_batch / batch size; release share = the release tx of the tick that delivered the lure / items released in that tick (a void is never delivered); reveal = gas only.

| Slot | Status | Commit share | Release share | Reveal | Total NEAR | Total USD | Release tx | Reveal tx |
| -: | :- | -: | -: | -: | -: | -: | :- | :- |
| 5 | Failed | 0.000113 | 0.000073 | 0.000659 | 0.000845 | n/a | [C3LEFRpn](https://testnet.nearblocks.io/txns/C3LEFRpn2gcZpX1TeA16MMLKs88w9g9daPv5htCM4RtK) | [AACtRwHX](https://testnet.nearblocks.io/txns/AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az) |
| 0 | Passed | 0.000112 | 0.000217 | 0.000289 | 0.000618 | n/a | [BmQNF4Qj](https://testnet.nearblocks.io/txns/BmQNF4QjBsgp4PaxKX9WAi1ifAnPuctLJWfpw6xxfp8X) | [7xdzzw5N](https://testnet.nearblocks.io/txns/7xdzzw5NJqHak3Md4YzSbjYhbbqdkaPe7JVTxxzzFUm8) |
| 1 | Passed | 0.000112 | 0.000216 | 0.000289 | 0.000618 | n/a | [2ngrcPLh](https://testnet.nearblocks.io/txns/2ngrcPLhV849RuM7BCBy2a2b8qcDKcTCptun9foMAfeQ) | [BcKeoKWe](https://testnet.nearblocks.io/txns/BcKeoKWeyovKLbAy6ef5et6uHFwr3wbijx8tCrAJbZvD) |
| 2 | Passed | 0.000112 | 0.000217 | 0.000297 | 0.000626 | n/a | [FtzNLxWW](https://testnet.nearblocks.io/txns/FtzNLxWWXdrAShMX91r9hZiVXuMACB9kCtRu4XjhTvRr) | [9VaXwD4a](https://testnet.nearblocks.io/txns/9VaXwD4av52yEru3TQPs4CjweWRWJfLQgMLPgaiacpMq) |
| 3 | Passed | 0.000113 | 0.000073 | 0.000289 | 0.000474 | n/a | [C3LEFRpn](https://testnet.nearblocks.io/txns/C3LEFRpn2gcZpX1TeA16MMLKs88w9g9daPv5htCM4RtK) | [CbtHvfzC](https://testnet.nearblocks.io/txns/CbtHvfzCoGLHC8PiW8ZUFJqtpqrjQoEUz8uS1xJzrv9b) |
| 4 | Passed | 0.000113 | 0.000073 | 0.000296 | 0.000482 | n/a | [C3LEFRpn](https://testnet.nearblocks.io/txns/C3LEFRpn2gcZpX1TeA16MMLKs88w9g9daPv5htCM4RtK) | [4qbbwgMK](https://testnet.nearblocks.io/txns/4qbbwgMKJK1Rp7ShQYDwF6sYmWXZSJ4f8o4GAQjDg6q4) |
| 6 | Void | 0.000114 | n/a | 0.000252 | 0.000365 | n/a |  | [C7imZ1st](https://testnet.nearblocks.io/txns/C7imZ1st24avingL6JSfQ9wUcV3QAQUP79U6aERuJRJj) |
| 7 | Passed | 0.000114 | 0.000109 | 0.000290 | 0.000513 | n/a | [2tMfQvXH](https://testnet.nearblocks.io/txns/2tMfQvXH9shntTcY9kdBrkckNRTVTc67uf8s8KD36Teh) | [DD17cLoc](https://testnet.nearblocks.io/txns/DD17cLocTdYz9P2yQQHLCRX516SXrJQfCceFRMJxZsvt) |
| 8 | Passed | 0.000114 | 0.000109 | 0.000289 | 0.000512 | n/a | [2tMfQvXH](https://testnet.nearblocks.io/txns/2tMfQvXH9shntTcY9kdBrkckNRTVTc67uf8s8KD36Teh) | [Fphkvw3k](https://testnet.nearblocks.io/txns/Fphkvw3kTNi55Uybp1sgw9sAaefioyviMK1S9nxk1oPH) |

### Summary

| Unit | Chain NEAR (burned) | Inference USD | Total USD | How |
| :- | -: | -: | -: | :- |
| Test slot, lure | 0.000586 | 0.00725 | n/a | mean of 8 delivered slots above |
| Test slot, void | 0.000365 | 0 | n/a | commit share + reveal |
| Batch (3 lures) | 0.001851 | 0.0217 | n/a | commit 0.000339 + 3 x (whole release 0.000218 + reveal 0.000286); upper bound, a release shared with real invoices costs the lure less |
| Day, tester default (TESTER_COMMIT_CRON 0 0 * * *, one commit a day) | 0.001851 | 0.0217 | n/a | 1 batch of 3 |
| Day, policy maximum (one batch every 6 h) | 0.007403 | 0.0870 | n/a | 4 batches of 3 |
| Failure (demotion + re-arm) | 0.497300 | 0 | n/a | Failed reveal gas 0.000659 ([AACtRwHX](https://testnet.nearblocks.io/txns/AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az)) + armed key destroyed 0.247714 + propose_key 0.000201 ([4ykUPr15](https://testnet.nearblocks.io/txns/4ykUPr159mT4XaxEpaBWTUeCFzmsyoXy34EKJq699g6A)) + accept_key gas 0.000579 ([7JkEMjHL](https://testnet.nearblocks.io/txns/7JkEMjHLifQS5dXcR3rwfAu6ZmojFNwiUctaeuiJJtPu)) + demoted key destroyed 0.248146 |
| Vault setup (once) | 0.008034 | 0 | n/a | CreateAccount+Transfer+UseGlobalContract+new 0.007313 ([5dgatWYd](https://testnet.nearblocks.io/txns/5dgatWYdyWeDUm216gMi5CWNiSdtu3xrNML9zXpNCopq)) + propose_key 0.000199 ([3R8c796g](https://testnet.nearblocks.io/txns/3R8c796gSbfAN8iA3V1gEp5ZuSGQYFrE2cZL7nUBGXW3)) + accept_key 0.000521 ([G9skjfnS](https://testnet.nearblocks.io/txns/G9skjfnS4doDNKYwa7a4ZkncrbbpCG4QQLE4MLLYceF4)); plus the NEAR the owner deposits (the vault's balance, storage and float) |
| Agent decision | 0.000529 | 0 (model is the vendor's) | n/a | decision tx 0.000375 (mean of 10 pay, decline, propose) + ack share 0.000154 (7 acks 0.000220 each over 10 items) |

Not in these figures: storage staked (locked, not burned, above), the vault's own NEAR float, the agent's model calls (the vendor's), the owner's wallet txs other than the ones listed, and drafts the tester rejected.
