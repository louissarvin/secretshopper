# Runbook

What to do when a part of Secret Shopper is down or something looks wrong. Every rule below comes from `contracts/shop/src/lib.rs` (2.3.0) and the backend code; line references are to those files.

## What the vault limits, whatever is down

The contract enforces the limits on chain. No backend, tester or webhook has to be up for them to hold.

| Limit | Rule (`pay`) |
|:-|:-|
| Per payment | `amount <= policy.max_per_payment` |
| Rolling 24 h | sum of the last 24 h of payments `<= policy.daily_cap` |
| Count | at most `policy.max_payments_per_day` payments in the rolling 24 h |
| New payees | at most `policy.max_new_payees_per_day` payees never paid before and not listed, in the rolling 24 h |
| Listed only | a `pay(.., listed_only: true)` refuses unlisted payees |
| Decisions | at most `policy.max_decisions_per_day` pays, declines and proposals per UTC day (`roll_day`) |

**Worst case.** An armed agent key, honest or not, can move at most `daily_cap` of the vault token in any rolling 24 h. It can keep doing that every 24 h until the owner freezes the vault, withdraws the token, or a failed lure demotes the key. Keys do not expire. If the tester is down, no new lures are committed, so no demotion can happen: exposure is `daily_cap` per 24 h until a human acts. A gas key also spends at most its funding (`key_allowance`, at most 1 NEAR) on gas per arming.

Check the live numbers: `GET /vendor/me` (`limits`, `fairness`) or the `get_policy` view.

## Emergency actions (wallet, not the API)

The API never signs. Send these from the owner's wallet or with near-cli, with 1 yoctoNEAR attached and 30 Tgas (the near-workspaces default of 10 Tgas fails).

| Action | Who | Effect |
|:-|:-|:-|
| `freeze()` | owner only (`assert_owner`) | Mode `Frozen` at once: the agent can no longer pay, decline, ack or propose. Deletes the agent key and drops any pending key |
| `withdraw({ amount })` | owner | Sends vault tokens to the owner. Works in any mode, so it cuts exposure even without a freeze |
| `set_limits(...)` | owner | Tightening applies at once; loosening waits `limits_delay` |
| `resync_key()` | anyone, no deposit | Re-applies the key state the mode implies to `stale_key`: re-scopes a demoted key, deletes a key left after freeze or re-arm. Panics `no stale key` when there is nothing to fix |

```bash
near contract call-function as-transaction <vault> freeze json-args '{}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <owner> network-config testnet sign-with-keychain send
```

**Re-arm** after a freeze or demotion:

1. Wait out `rearm_cooldown` after a demotion. `propose_key` refuses before it ends; `GET /vendor/me` shows `cooldownEndsAt`. A freeze alone has no cooldown.
2. The owner calls `propose_key({ public_key })` (1 yocto).
3. The vendor checks the key is its own agent's (`pendingKeyMatchesArmed` on `/vendor/me`) and calls `accept_key({ public_key })` (1 yocto, `acceptKey` on `/vendor/me` is the exact call). For a gas key (`key_nonces > 0`) the vault needs free NEAR for the key funding; top it up first if `accept_key` says so.
4. If `/vendor/me` `staleKey` is set afterwards, anyone calls `resync_key`.

## When a part is down

| Down | What stops | What still holds | What to do |
|:-|:-|:-|:-|
| **API** (`backend/index.ts`) | Agent inbox (no new invoices reach the agent, so it makes no decisions), indexer, projector, alert webhooks, web app reads | All vault limits; the tester keeps committing, releasing and revealing | Restart it. The indexer resumes from its `ChainCursor`; the alert worker resumes from `alerts:<shop>` and sends what it missed. Lures delivered while it was down reveal `Unanswered` (not scored) |
| **Tester** (`backend/tester.ts`) | New lure batches, release roots, reveals, delivery proofs | Limits. Already committed lures still expire on schedule | Health alerts `tester_stalled` and `reveal_overdue` fire. Restart it; `recoverPrepared` finishes a commit interrupted between tx and DB. Lures with no release root reveal `Unanswered`. Reveal overdue slots with the keeper (below) if the tester stays down |
| **Agent** (`agent/index.ts`) | Decisions and acks | Limits; the key stays armed | Real invoices wait: pay them yourself or let the agent catch up. Lures without an ack reveal `Unanswered`, not `Ignored` |
| **NEAR RPC** | API views (502), indexer, tester txs, agent txs | Everything on chain | Set `NEAR_RPC_URLS` (comma separated) for failover in each process. Workers retry each tick; the indexer resumes from its cursor |
| **drand** (`api.drand.sh`) | Tester commits (sealing a batch fetches drand chain info), keeper reveals (need the round's beacon) | Tester reveals use the sealed preimage in its DB, not drand | Commits resume when drand is back. A slot can be revealed by anyone only after its round is published |

The tester decides batch timing and the tlock round from chain time (`chainNowMs`, `chainHeadMs`), not the host clock. It logs `host clock differs from chain time` when they disagree by more than 30 s; fix NTP, but commits keep working.

## Self-serve vaults in the tester (v2/37)

One tester process serves the default vault and every vault whose owner enabled testing. Each vault's state is on its company row (`GET /company/tester` with `X-Shop`, `testerState`); the tester logs every failure with its `shop`, and a failure in one vault never stops another.

| State | Meaning | Fix |
|:-|:-|:-|
| `provisioning` | The tester has not written this vault's public key yet | Wait a minute; check the tester runs and `TESTER_KEY_SEED` is set |
| `key_missing`, `key_scope`, `allowance_unlimited`, `allowance_low` | The owner's tester key is absent, has the wrong receiver or methods, no allowance limit, or less than `TESTER_MIN_ALLOWANCE_YOCTO` left | The owner deletes and re-adds the key from `GET /public/tester/:shopId` (four methods, finite allowance). Until then the tester signs nothing for that vault; anyone reveals its slots with the keeper after the tlock round |
| `owner_changed` | `get_status.owner_id` is not the account recorded at enable | Disable and re-enable testing as the new owner |
| `unarmed`, `no_vendors`, `policy_unsupported`, `low_float`, `over_capacity` | No commit this time; reveals, releases and proofs continue | Arm the agent, add a vendor, use a supported policy, top up vault NEAR, or wait for capacity |
| `budget` | `TESTER_MAX_LURES_PER_DAY` is spent | Commits continue with void slots until the rolling day frees calls |
| `error` | A job threw for this vault | Read the tester log for that `shop` |

Disabling testing stops new commits only: open slots are still revealed. If `TESTER_KEY_SEED` is lost or rotated, every non-default vault's key changes: its owner must re-add the new key, and the keeper reveals the open slots meanwhile. The default vault never depends on the seed.

## Health alerts

The API checks every `ALERT_HEALTH_SECONDS` (default 60), with or without webhooks. Active conditions show in `GET /company/alerts` (`health`), and each change that fires is sent to `ALERT_WEBHOOK_URLS`.

| Kind | Fires when | Usual cause |
|:-|:-|:-|
| `reveal_overdue` | `get_scorecard.overdue_unrevealed` rises | Tester down, or its key out of NEAR |
| `tester_stalled` | The newest delivery tick at least two ticks (and 15 min) old has no indexed `release_posted`; or the vault is Armed and no batch landed within `batch_interval` + 1 h | Tester down, `TESTER_COMMIT_CRON` slower than `batch_interval`, drand down, or the API indexer behind |
| `gas_key_overfunded` | An agent gas key holds more than `key_allowance` + 10% | Someone sent NEAR to the key (V23-01). Above 1 NEAR its `DeleteKey` fails, so a demotion or freeze leaves the key; it keeps no authority (the contract checks mode and `agent_key`) but stays on the account. Watch `staleKey`, call `resync_key` once it is spent down |

## Reveal overdue slots without the owner

`scripts/keeper.ts` reveals every committed slot whose drand round is published, from any funded account. It needs no backend, database or seal key: it reads each slot's tlock ciphertext from the commit tx, checks its sha256 against the chain, decrypts it with drand and calls the permissionless `reveal`.

```bash
cd scripts
NEAR_NETWORK=testnet KEEPER_ACCOUNT_ID=<any funded account> bun keeper.ts <vault> --once
# keeps running every 60 s without --once; --commit-tx <hash>@<signer> skips tx discovery
```

The key comes from `KEEPER_PRIVATE_KEY` or `~/.near-credentials/<network>/<account>.json`, never argv. Exit code 1 means a ciphertext failed its hash, would not open, or opened to a wrong preimage: evidence of owner sabotage, keep the log.
