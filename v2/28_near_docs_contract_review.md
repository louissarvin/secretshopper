# 28. NEAR docs review: vault contract and deploy/verify tooling

Date: 2026-11-06. Scope: vault 2.2.0 and its deploy/verify scripts. Doc paths are relative to `reference/near-docs/`. (src): checked in near-sdk 5.29.1 or near-api-js 7.4.0 source. [VERIFY]: not proven in a sandbox.

## 1. Features we do not use

| # | Doc | What it says | Change | Effort | Risk |
|:-|:-|:-|:-|:-|:-|
| F1 | protocol/accounts-contracts/gas-keys.md, protocol/transactions/gas.md | Gas comes from the key's balance, not the account; FC gas keys take no allowance; DeleteKey burns the balance, fails above 1 NEAR; contracts add and fund, only the account's own txs withdraw. Gas is bought at 0.001 NEAR/Tgas or more | `accept_key`, `demote`: `add_gas_key_allowance_function_call` plus `transfer_to_gas_key` (src, promise.rs:742,766). New `Policy.agent_gas_budget` under 1 NEAR; owner `fund_agent_gas` (1 yocto, from `free_near`); drop the rule at lib.rs:507. An 80 Tgas `pay` (agent/src/config.ts:46) now reserves about 0.08 NEAR of vault balance against 0.1 NEAR headroom (vault-deploy.ts:35); gas keys move agent gas off the float (closes V21-01, V21-05 structurally) | M | Budget burned on demote/freeze, locked vault cannot withdraw it. [VERIFY] SDK takes an `allowance` the docs forbid; whether outsiders can send `TransferToGasKey` to push the key over 1 NEAR and fail demotion's DeleteKey; near-workspaces support. near-api-js 7.4.0 signs with `nonceIndex` (src) |
| F2 | smart-contracts/anatomy/reduce-size.md (Reproducible builds), security/checklist.md | NEP-330 plus cargo-near Docker build, then NearBlocks "Verify and Publish" via SourceScan; checklist: "deployed code hash is verified" | Built wasm reports `"link":null` and `"build_info":null`. Add `repository` to Cargo.toml, build `reproducible-wasm`, publish the global hash from that artifact. Declare `contract_metadata(standard(standard = "secret_shopper", version = "2.1.0"))` (src, near-sdk-macros). `verify-evidence.ts`: read `contract_source_metadata`, require `build_info`, print `source_code_snapshot`, compare the code hash to a released hash | S | New code hash. [VERIFY] NearBlocks verification of an account that only references a global hash |
| F3 | protocol/accounts-contracts/account-id.md, protocol/tutorials/creating-deterministic-accounts.md | `0s` id is derived from code and initial storage; creation gives the sender no control | Optional vault mode via `DeterministicStateInit` with a fresh `STATE`. The verifier recomputes the id from (code hash, state bytes): no creation tx, archival RPC or FastNEAR (`attestVault`, chainread.ts:44) | L | Skips `new` checks (verifier must check policy); exact borsh layout of `Shop`; near-api-js has no StateInit builder (near-cli-rs, near-kit do) |
| F4 | security/cross-contract-calls/callback-failures.md | `#[callback_result]` panics on mismatched data; use `env::promise_result_checked`; bound loops; "Monitor failed callbacks" | `on_paid_intents` (lib.rs:1174): `promise_result_checked(0, 64)`, malformed means spent 0. Cap `max_payments_per_day` in `new` (`settle` scans `spend_window`). Worst-case `on_paid` row in `tests/costs.rs`. Backend: alert on failed `on_paid*`/`on_withdrawn` receipts, not only drop them (events.ts:106) | S | None |
| F5 | smart-contracts/global-contracts.md | Publishing burns "10 NEAR per 100KB" | Wasm is 292 KB, about 29 NEAR on mainnet. Apply reduce-size.md before publishing: drop `rlib` (Cargo.toml:8, no test imports the crate), fewer `format!` panics | S | Re-run suites |

Not a fit: chain signatures, meta transactions (C1). Later: light client proofs (api-reference/post-light_client_proof.md) so the verifier need not trust one RPC.

## 2. Code against current docs

| # | Where | Doc | Finding | Fix |
|:-|:-|:-|:-|:-|
| C1 | lib.rs:1309-1316 | protocol/transactions/meta-tx.md: in a meta tx the signer "is still the relayer" | Agent identity is `signer_account_pk`, so relayed agent calls are refused (fail-closed). Relaying would also skip the allowance | Keep; document; F1 is the sanctioned gas path |
| C2 | lib.rs:583-612, 617-628, 931, 1553-1576 | checklist: outcome-dependent state "committed in the callback", initiator "returns its Promise"; transaction-execution.md: a tx can succeed "even though one of its receipts fails" | V2-13. `accept_key`, `freeze` detach, so the vendor's tx shows success even if AddKey failed | Section 3 |
| C4 | events.ts:106, lib.rs:1177 | checklist: "alerts on every failed callback receipt"; callback-failures.md | Failed receipts dropped silently; a callback panic leaves the payment `Pending` with its cap mark held | F4 |
| C6 | lib.rs:458 | security/frontrunning.md: "Bind the commitment to the account and round" | Preimage carries no vault id (round is stored beside it). No exploit found | Add `current_account_id` at the next format change (parity test). Info |
| C7 | verify-evidence.ts:75 | api JSON for `view_access_key_list`: `GasKeyFullAccess`, `GasKeyFunctionCall` | Check 1 compares to the string `'FullAccess'`, so a `GasKeyFullAccess` key passes it (the per-key scope check still fails it) | Accept only `FunctionCall`/`GasKeyFunctionCall`; needed for F1 |
| C8 | contracts/shop/tests | testing/integration-test.md:17 prefers `near-sandbox` plus `near-api` | near-workspaces 0.24 | Matters for F1/F3 tests |

Consistent: allowance never 0 (lib.rs:516; from a contract 0 means unlimited), 1 yocto on owner methods, `#[private]` callbacks, `overflow-checks`, code by hash (upgrade.md), create plus init in one tx (global-contracts.md).

## 3. Proposals

**V2-02.** Yield/resume (anatomy/yield-resume.md) times out after 200 blocks, about 2 minutes, far shorter than release ticks. TEE attestation (primitives/off-chain-compute/what-is.md) could attest the release service, not receipt by the agent. What fits is the agent's own FC key (access-keys.md method lists):

1. Add `ack` to `PAY_METHODS` and `PROPOSE_METHODS`.
2. Per release tick the tester posts `release(tick, root, count)`, a padded Merkle root over sha256(invoice_id) of every item (v2/25).
3. The agent harness recomputes the root from what it fetched and calls `ack(tick, root)`; `assert_agent` binds it to the armed key. Keep `(root, at)` per tick until its batches are revealed.
4. `reveal` takes an optional inclusion proof. An undecided lure whose leaf is in an acked root inside `[committed_at, expires_at - min_answer]` becomes `Ignored` (scored); otherwise `Unanswered` (unscored). An owner root that differs from the agent's ack is on-chain evidence of a forked inbox.

The agent cannot skip lure acks selectively (one root per tick). Cost: about 2 Tgas per tick, 0.0025 NEAR a day at 120-minute ticks.

**V2-13.** Per callback-failures.md, commit state after the outcome is known:

- `accept_key`, `freeze`: return `Promise` with `.then(on_key_op(pk, op))`; emit `AgentArmed`/`AgentFrozen` with `ok` there; failed arming resets to `Unarmed`.
- `demote`: keep `mode = Demoted` synchronous (authority must not wait) and `AgentDemoted` without `methods`; add `AgentKeySwapped { public_key, methods, ok }` from a callback. On failure set `key_stale`; permissionless `resync_key()` retries while Demoted.
- `withdraw_near`: `.then(on_near_withdrawn(amount))` emitting `NearWithdrawn { amount, ok }`, like `on_withdrawn` (lib.rs:1185).
- Test failure paths with the V21-01 drain setup.

**V2-08.** No doc primitive applies; it needs `listed_at`/`removed_at` windows in the `invalid` test (lib.rs:1052-1055).
