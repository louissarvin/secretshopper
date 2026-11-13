# AGENTS.md

Instructions for AI reviewers and coding agents working in this repository. What the product is and why: [README.md](README.md). Every claim mapped to a test and on-chain evidence: [README.md, Claims](README.md#claims-and-how-to-check-them).

All commands below were last run on 2026-11-12 and 2026-11-13 (macOS arm64, Rust 1.97.1, cargo-near 0.22.0, Bun 1.4.4) and the expected output is copied from those runs; `bun run verify` takes about 13 to 20 minutes on a clean clone (1,215 s on a fresh GitHub clone on 2026-11-13, most of it the contract sandbox tests).

## Rules for coding agents

- Bun loads `.env` from the working directory automatically. Never read, print or commit `.env` files; use the `.env*.example` files for variable names.
- Never sign transactions on mainnet, spend tokens, or deploy without the human's confirmation.
- Do not run destructive Prisma commands (`migrate reset`, `db push` with force reset). Schema changes go through the human (`backend/CLAUDE.md`).
- `backend/src/tester/` is a separate process with its own secrets. API code must not import it; `backend/test/separation.test.ts` enforces this.
- The agent must not get database access; `agent/test/separation.test.ts` enforces this.
- After changing `contracts/shop/src/lib.rs`, rebuild the wasm before `cargo test`: the sandbox tests load `target/near/secret_shopper.wasm`, not the source.
- Keep the TypeScript commitment and the Rust `commitment_of` in sync; the parity test fails otherwise.
- Keep the three release Merkle trees (`contracts/shop/src/lib.rs`, `backend/src/lib/proof/merkle.ts`, `agent/src/merkle.ts`) in sync; each asserts the same fixed vectors.

## Toolchain

| Tool | Version | Note |
|:-|:-|:-|
| Rust | 1.97.1 with `wasm32-unknown-unknown` | Pinned by `contracts/shop/rust-toolchain.toml`; rustup selects it inside `contracts/shop` |
| cargo-near | 0.22.0 | `cargo install --locked cargo-near --version 0.22.0` |
| Bun | 1.4.4 or newer | `engines.bun` in every package |
| Network | `api.drand.sh` reachable | Only for `bun run demo` and the optional live tlock test. `1click.chaindefuser.com` only for the optional live quote test |

`target/` is not committed. Build both wasm files before any contract test or the demo.

## Build and test

### One command

```bash
bun run setup && bun run verify   # about 13 to 20 minutes; flags: --skip-contract, --skip-demo
```

It runs every check below that needs no secret, prints a table and writes `scripts/out/verify-report.json`. It exits 0 only if every step passed. Expected last line: `VERIFY PASS: 12 steps passed, 0 skipped.` (2026-11-12, recorded with `bun run verify --record` in [backend/data/verify-report.json](backend/data/verify-report.json) and served at `GET /public/verify-report`; a plain run writes only `scripts/out/verify-report.json`, so it leaves the tree clean; the 12th step is the bring-your-own-agent MCP run, `scripts/mcp-e2e.ts`). The JSON report holds each step's status, time and summary line, so an automated reviewer can read the result without parsing the log.

### Install JS dependencies (all packages)

```bash
bun run setup        # from the repo root: bun install in backend/, agent/, scripts/, and prisma generate (no database needed)
```

### Contract: `contracts/shop`

```bash
cd contracts/shop
cargo near build non-reproducible-wasm                                   # target/near/secret_shopper.wasm
(cd tests/fixtures/ft && cargo near build non-reproducible-wasm --no-abi) # tUSDC fixture wasm
cargo test -- --test-threads=4
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The run below spent about 300 s in tests after the build. Each sandbox test starts its own local nearcore sandbox. Keep `--test-threads=4`: 30 or more parallel sandboxes under load can push the timing-based tests (for example `withheld_failure_does_not_demote_a_new_arming`) past their waits. Expected tail lines (one per test target, unit tests first):

```
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 16.29s
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 185.91s   (audit_v21)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 11.28s   (costs)
test result: ok. 35 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 177.67s  (sandbox)
```

`cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` are clean. Plain `cargo clippy -- -D warnings` fails inside near-sdk's host-build guard (`could not compile near-sdk`); use the `--all-targets` form.

The source is contract 2.3.0 and the build prints `SHA-256 checksum bs58: 5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs` (host build). To get that hash on any machine, map your cargo package cache to the path the deployed build used: `cargo near build non-reproducible-wasm --env "RUSTFLAGS=-C link-arg=-s --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/Users/macbookair/.cargo"` (verified 2026-11-12 with a fresh `CARGO_HOME`; `bun run verify` does this and fails on any other hash). 2.3.0 runs on testnet as `shop4.ss-owner-e9c3db.testnet` since 2026-11-11: the non-reproducible build was published as a NEP-591 global contract by hash (`near contract deploy-as-global`, tx `DfK5xMMWdjU8byKV1BRBob19kLhwVuaXWuM5aj2yTFeX`), and `create-vault.ts --code-hash` created, attached and initialized the vault in one tx, so `verify-evidence` attests it with no `--allow-unattested`. Its `view_account` shows `global_contract_hash` equal to the build. `shop3.ss-owner-e9c3db.testnet` is the same code deployed classic (`code_hash` equal to the build, needs `--allow-unattested`). The older vault `shop2.ss-owner-e9c3db.testnet` keeps 2.0.0 (`code_hash` `ATAnPJbfjhwh75SZ5fF8rizzWrLUiBULFarhFunyqGtK`). What changed since 2.0.0:

| Version | Changes |
|:-|:-|
| 2.1.0 | Rolling 24 h new-payee limit (V2-10); agent and tester writes cannot spend the reveal float (V2-09); `Misdirected` outcome (V2-11); tighter limit fields apply at once (V2-12); tlock ciphertexts checked on chain (V2-05) |
| 2.2.0 | Scoring keyed by agent decision so reveal order cannot pick an outcome (V2-02 ordering); a partly kept Intents deposit stays on the cap (V2-14); key changes and NEAR withdrawals reported from callbacks, with a permissionless `resync_key` for a failed key change (V2-13) |
| 2.3.0 | NEP-611 gas-key agent keys (`Policy.key_nonces`, 0 classic or 1 to 64 lanes, funded with `key_allowance` of at most 1 NEAR at every add; `checkPolicy` in `create-vault.ts` and the self-serve plan caps a gas key at 0.5 NEAR, V23-14); delivery proof closing V2-02 (`release`, `ack`, `reveal(.., delivery)`, `prove_delivery`, `Ignored`, mandatory `Policy.min_answer`); Intents `ft_transfer_call` with 100 Tgas; fixes V23-02 to V23-11 from the 2.3.0 audit (V23-12 documented) |

Agent key methods are `pay,decline,ack` while Armed and `propose,decline,ack` after demotion. The tester key needs `commit_batch`, `reveal`, `release` and `prove_delivery`. Owner and vendor calls to `accept_key`, `freeze` and `withdraw_near` need about 15 Tgas; the near-workspaces default of 10 Tgas fails. The sandbox tests use classic agent keys; gas keys are covered by the unit tests and end to end by the demo. A later vault will be deployed from the reproducible build once the repo is public. The `cost_profile` target prints `never used` warnings for shared helpers; they are harmless.

### Backend: `backend/`

```bash
cd backend
bun test
bun run typecheck
bun run lint
```

Expected `bun test` tail:

```
 347 pass
 49 skip
 0 fail
Ran 396 tests across 41 files.
```

The 49 skips (31 tests and the hooks of their gated suites) are gated on purpose:

| Skipped | Needs |
|:-|:-|
| Route and scenario tests on a real database: `inbox.route`, `releases.route`, `company.route`, `vendor.console`, `alerts.health`, `blocklist`, `throughput.reputation`, `tester.vaults`, `multivault.route` (28 tests) | `TEST_DATABASE_URL` (a throwaway Postgres URL) |
| 2 live drand tests (refuses a far round, opens a near one) | `NETWORK_TESTS=1`: `NETWORK_TESTS=1 bun test test/tlock.test.ts` |
| 1 live 1Click dry quote | `NETWORK_TESTS=1`: `NETWORK_TESTS=1 bun test test/intents.quote.test.ts` |

With both gates open nothing is skipped. Run on 2026-11-13 against a throwaway local Postgres (schema created with `bun run db:push` on an empty database, never on a real one); the test preload refuses the development database:

```bash
TEST_DATABASE_URL='postgresql://user@127.0.0.1:5432/scratch?schema=public' NETWORK_TESTS=1 bun test
```

```
 378 pass
 0 fail
Ran 378 tests across 41 files.
```

Three full runs in a row on 2026-11-13 passed with 0 fail. The gated total is lower than the ungated one because skipped hooks are no longer counted once they run. drand answered in 1.5 to 7 s on 2026-11-12, so the live drand test checks the early refusal on a round days away instead of racing a near one. CI runs the database tests on every push (`.github/workflows/ci.yml`, Postgres 15 service).

### Agent: `agent/`

```bash
cd agent
bun test
bun run typecheck
```

Expected `bun test` tail:

```
 109 pass
 0 fail
Ran 109 tests across 12 files.
```

### Scripts and the end-to-end demo

```bash
cd scripts && bun run typecheck
cd .. && bun run demo
```

`bun run demo` takes about 60 seconds and needs no account, key or database. It exits 0 only if all 33 checks hold. Expected last line (60.9 s on the run in `scripts/demo.md`; the time varies):

```
PASS: all 33 checks held in 60.9s.
```

`bun scripts/global-vault.ts` ends with `PASS: global vault checks held`. `bun scripts/create-vault.ts` prints the agent key mode (classic key or gas key with its lanes and funding) and the answer time `min_answer` before anything is signed. `bun scripts/ledger-csv.ts <vault>` writes one row per payment, proposal, decline and test slot. Full demo output and what is real versus stand-in: [scripts/demo.md](scripts/demo.md).

## What each test proves

### `contracts/shop`

58 contract tests: 35 sandbox (`tests/sandbox.rs`), 4 audit regressions (`tests/audit_v21.rs`), 18 unit (`src/lib.rs`) and 1 cost profile (`tests/costs.rs`). The table of every test and what it proves is in [contracts/shop/README.md, Tests map](contracts/shop/README.md#tests-map); the main claims are mapped in [README.md, Claims](README.md#claims-and-how-to-check-them).

### `backend/test/`

| File | Proves |
|:-|:-|
| `audit.regression.test.ts` | Each first-audit backend finding SS-B01 to SS-B07 stays fixed (inverted proof of concept per finding) |
| `commitment.parity.test.ts` | TypeScript commitment equals the Rust `commitment_of`; writes `test/fixtures/commitment.json` |
| `merkle.test.ts` | Release Merkle tree matches fixed vectors from an independent Python computation; every leaf verifies, flipped bytes, wrong index or count fail, a node cannot pass as a leaf; writes `test/fixtures/merkle.json` and reads `contracts/shop/tests/fixtures/merkle.json`, so every root and proof is checked against the Rust output |
| `canonical.test.ts` | Canonical invoice id is stable and matches the browser implementation |
| `tlock.test.ts` | drand round math equals tlock-js and the contract; live (gated): a ciphertext for a far round is refused, one for a near round opens after it is published; the chosen round lands in the contract range for any commit block within the margin, which is a third of `reveal_grace` (3 s to 30 s) so sealing and a slow block cannot push expiry past the round |
| `seal.test.ts` | AES-256-GCM sealing of test preimages; tampering and wrong keys fail |
| `receipt.verify.test.ts` | NEAR AI receipt check: both signature formats and ed25519 verify, with or without `0x`; wrong lengths and non-hex fail before any crypto; one changed byte or wrong signer fails; the result states its scope (byte integrity and signer consistency only, gateway is `partial`) |
| `attestation.binding.test.ts` | `verifyReceiptAgainstAttestation` binds a receipt signer to the key in a stored attestation, offline; another key, or a stored conclusion that disagrees with the raw report, fails; gateway receipts stay `partial`; the public slot view reads `attested_signer` only when the stored attestation binds, and carries a summary, never the raw report |
| `accessKeys.test.ts` | `FullAccess` and `GasKeyFullAccess` are both full access; `GasKeyFunctionCall` keeps receiver and methods; unknown or malformed permissions fail closed; only `pay,decline` or `propose,decline`, plus `ack` from 2.3.0, on the vault is an agent scope |
| `ledger.test.ts` | Ledger CSV: escaping, spreadsheet formula guard (OWASP CSV injection), exact token decimals, one row per payment, proposal, decline and slot; a delivery proof upgrades the slot row from `Unanswered` to `Ignored` in place; no double count |
| `evidence.test.ts` | Public evidence bundle hides unrevealed slots, carries preimages after reveal, labels gateway receipts `partial` |
| `delivery.test.ts` | Release tick scheduling |
| `separation.test.ts` | API code cannot import tester code (lint rule) |
| `inbox.route.test.ts` | Real and test inbox items serialize identically (needs Postgres) |
| `company.route.test.ts` | `GET /company/me` returns this deployment's vault even when the owner registered others first, `null` for an owner of other vaults only, whose owner-route calls are 403 (needs Postgres) |
| `releases.route.test.ts` | `GET /public/releases/:shopId` lists closed ticks with sorted ids and a root anyone can recompute; no settling or future tick; paging, 400 on bad input, 404 on an unknown shop (needs Postgres) |
| `intents.quote.test.ts` | 1Click dry quote: documented request shape, JWT only in `X-API-Key`, input refused before any request, plain http refused, exact unit conversion, 400 and 5xx mapping, mismatched or incomplete answers refused; a global sliding budget caps partner-key quotes and a cached token list makes one quote one upstream call (B23-04); `GET /public/quote` returns 200, 400 or 502; one live quote with `NETWORK_TESTS=1` |
| `audit230.regression.test.ts` | Each finding of the 2.3.0 backend audit (B23) stays fixed: the public evidence route is paged, cached and limited to 20 requests a minute per IP (B23-01); an invoice never lands on a tick that has already passed and the tester timestamps after its slow reads (B23-02); no lure tick after `expires_at - min_answer` (B23-03); a release already on chain is compared with the recomputed root (B23-05); write headroom includes the 2,000-byte flush margin (B23-06); real release history excludes tests by their real expiry (B23-07); a losing concurrent finalize inserts nothing and still records the signer (B23-09); an `Ignored` event never passes a `prove_delivery` tx off as the reveal tx (B23-10) |
| `generator.test.ts` | Lure drafts: reasoning stays on unless `GENERATOR_THINKING=off`, which sends `enable_thinking=false` on every attempt; prompt assembly (issue window, email samples, lookalike domains, payee only when drawn); `parseDraft` refuses stale or inconsistent dates, arithmetic that does not add up to the cent, filler lines, ISO dates in prose and wrong domains; every real B1 item clears the same rules; each vendor's own layout is kept and checked (`lines` or `items` with `sku`, `hours`, `amount`, or a single `service`; payee in `pay_to`, `remit_to` or `payment.account`; `amount_due` equals the total; a `YYYY-MM` period is recent), and a draft using another layout than the vendor's samples is refused |
| `vendor.console.test.ts` | `/vendor/me` answers only the on-chain `vendor_id` (the owner included gets 403) with the exact `accept_key` call for a pending key; `cooldownEndsAt` is `demoted_at + rearm_cooldown` in ns; history lists the key lifecycle and test outcomes newest first, paged; the owner alert feed holds alert-worthy events only and is owner only; an invalid webhook URL stops the API at startup (5 of 10 need Postgres) |
| `alerts.test.ts` | One mapper turns each contract event into an activity item with one-line plain text; the webhook sends only demotion, failed test, proposal, arming and freeze; webhook URLs must be https (http on localhost only), private, link-local and reserved hosts are refused in any spelling, errors never echo the URL; HMAC-SHA256 over the exact body; 5xx, 429 and timeouts retried up to 3 times; redirects not followed |
| `vault.plan.test.ts` | Self-serve vault: the default policy equals the testnet fixture and passes `checkPolicy`; a request yields exactly two NEAR Connect transactions (create, fund, attach the global code by hash and `new` in one, token `storage_deposit` in the other); bad names, ids, amounts, same owner and vendor, underfunding, a policy the contract refuses, an existing vault, unpublished code, a token without NEP-145 and mainnet are refused with field errors; the vault view accepts only initialized vaults on the configured global hash (422 with the account's hash otherwise, 404 when missing) and returns raw keys and `createdTx` |
| `txapi.retry.test.ts` | A FastNEAR 429 is retried after Retry-After instead of failing the indexer run |
| `float.test.ts` | The tester's float headroom matches the contract's `reserve()`: storage, the larger of the float and the open reveals (V21-05), plus the armed gas-key re-key (V23-08) |

### `agent/test/`

| File | Proves |
|:-|:-|
| `tools.test.ts` | Tool argument validation, mode gating, Intents gating, 140-byte decline reason, no chain call on bad input; at most 3 signed calls per invoice (AG-02) |
| `vendor.test.ts` | `get_vendor` uses on-chain approved payees and their active window, never database payees |
| `separation.test.ts` | The agent has no database URL and imports nothing from `backend/` |
| `preflight.test.ts` | Allow, warn, block rules; an approved payee whose on-chain label names another vendor, or an invoice with no vendor on file, is warn so `pay` signs nothing (AG-07); block signs nothing; warn refuses `pay` and routes a demoted key to `propose`; allow signs the exact payee and amount checked; a failed chain read blocks |
| `mcp.test.ts` | Bring-your-own-agent MCP server: exactly 7 tools with strict schemas and the AP policy; the same guards as the native tools (preflight block signs nothing, at most 3 signed calls per invoice (AG-02), demoted `pay` refused and `propose` signs, runtime refusals verbatim, unarmed reads no inbox, 128 KB inbox cap (AG-08)); parallel calls are serialized; release acks keep running; an invoice left undecided past `MCP_DECISION_TIMEOUT_S` or `MCP_MAX_TOOL_CALLS_PER_INVOICE` is acked like `MAX_STEPS` in `index.ts`; refuses to start next to a running native agent; stdout carries only JSON-RPC |
| `loop.test.ts` | Every model step is verified and its receipt id kept with the decision; a reply that fails signature verification runs no tool; the production entry point refuses gateway-signed receipts (AG-04) (`recorder.ts` is a helper) |
| `merkle.test.ts` | The agent's copy of the release Merkle tree holds the same fixed vectors as the backend and the contract |
| `acks.test.ts` | One ack per tick over every id the decision loop advanced past, after the release is posted; a closed tick is never reopened and an item given up after repeated failures stays out (AG-01, AG-03); restart resumes from saved state; an ack already on chain is not resent; no signing while unarmed; a failed ack backs off; a tick with no release is dropped after a week |
| `config.test.ts` | Numeric settings are bounded integers (AG-06); the FastNEAR key goes to `fastnear.com` and its subdomains only (AG-05); state left by the old independent ack walk is dropped on load (AG-01); inbox bodies over 128 KB are refused before parsing (AG-08) |

## Where the evidence is

| Evidence | Location |
|:-|:-|
| Claims with tests and tx links | [README.md, Claims](README.md#claims-and-how-to-check-them) |
| HTTP API for the web app, checked live | [backend/API.md](backend/API.md), `scripts/api-smoke.ts` |
| Testnet deployment and tx links | [README.md, Live deployment](README.md#live-deployment), [full lifecycle](README.md#the-full-lifecycle-step-by-step-with-a-real-example) |
| Testnet runs (verify, deploy, attack demo, blocklist, keeper) | [README.md, Live evidence](README.md#live-evidence): one-line results with tx links; global publish `DfK5xMMWdjU8byKV1BRBob19kLhwVuaXWuM5aj2yTFeX`, shop4 create `5dgatWYdyWeDUm216gMi5CWNiSdtu3xrNML9zXpNCopq`, failed reveal and demotion `AACtRwHXbwtFheHFG3EynuZkfvKct9DqzzYGpqZ1Y4Az` |
| Published evidence bundles | `scripts/evidence/shop4.ss-owner-e9c3db.testnet.json`, `scripts/evidence/shop2.ss-owner-e9c3db.testnet.json` |
| Demo evidence bundle from the last local run | `scripts/out/demo-evidence.json` (and the tampered copy) |
| Model runs, B1 summary, recorded verify report | `backend/data/model-runs/`, `backend/data/b1-summary.json`, `backend/data/verify-report.json` (served by `GET /public/model-runs` and `GET /public/verify-report`) |
| Measured costs | `cd scripts && bun unit-cost.ts`; summary in [README.md, What it costs](README.md#what-it-costs) |
| Contract design | [contracts/shop/README.md](contracts/shop/README.md): modes, methods, scoring, delivery proof, policy fields, events |
| Intents rail | `Rail::Intents` and `GAS_FT_CALL` in `contracts/shop/src/lib.rs`, `backend/src/lib/intents/quote.ts`, `scripts/intents-quote.ts` |
| Audits and their regressions | [README.md, Audits](README.md#audits); `backend/test/audit.regression.test.ts`, `contracts/shop/tests/audit_v21.rs`, `backend/test/audit230.regression.test.ts` |
| Operations | [README.md, If something is down](README.md#if-something-is-down), [README.md, Deploy](README.md#deploy) |

## What needs secrets and what does not

| Command | Needs |
|:-|:-|
| `cargo test`, `bun test` (backend, agent), all `typecheck`, `lint` | Nothing. Verified with an empty environment and no `.env` loaded |
| `bun scripts/global-vault.ts` | Nothing (local sandbox): publishes the vault as a global contract by hash, compares a classic vault, checks init access |
| `bun scripts/ledger-csv.ts <vault>` | Nothing: read-only `NEAR_NETWORK`, `NEAR_RPC_URL`, `NEAR_TX_API_URL` (FastNEAR). Not for the sandbox |
| `bun scripts/intents-quote.ts` | Nothing but network access to 1Click. Optional `ONECLICK_JWT` (partner key, else the unauthenticated fee) and `ONECLICK_API_URL` |
| `bun scripts/create-vault.ts` | Dry run: nothing. `--send`: the owner's key in `~/.near-credentials`. Creates a vault in one tx (global `--code-hash`) or with a self-deleting one-time key (`--wasm`); refuses existing vaults, missing vendor or token, weak policies (including a missing or out-of-range `min_answer` and more than 64 key lanes), too little NEAR, unpublished code; mainnet also needs `--mainnet`. `--intents` accepts only `intents.near` on mainnet; testnet needs `--allow-unverified-intents` |
| `bun run demo` | Internet access to drand. Optional `NEARAI_API_KEY_AGENT` switches the decider to a live NEAR AI model |
| Testnet RPC checks in the README | Nothing |
| `backend/test/inbox.route.test.ts`, `releases.route.test.ts` | `TEST_DATABASE_URL` (Postgres) |
| `scripts/api-smoke.ts` | A running API and its vault. Read-only; `--owner` and `--vendor` sign in with that account's key from `~/.near-credentials` (NEP-413). Ends with `API SMOKE PASS` (59 checks with both flags on 2026-11-12) |
| `scripts/blocklist-demo.ts` | A running API and its vault; the owner's key in `~/.near-credentials` (NEP-413 sign-in) and `agent/.env` for the inbox token (`bun --env-file=../agent/.env`). Signs no transaction. Writes a transcript log; the 2026-11-12 result is in [README.md, Live evidence](README.md#live-evidence) |
| `scripts/hosting-snapshot.ts` | Local and hosted Postgres URLs in env (never printed). Copies only public, revealed data to the hosted read-only database ([README.md, Deploy](README.md#deploy)) |
| `scripts/selfserve-e2e.ts` | The owner's key in `~/.near-credentials` and a running API. Signs the API's self-serve plan unchanged on testnet (about 1 NEAR) and reads the new vault back; refuses mainnet |
| `scripts/multi-vault-e2e.ts` | `TEST_DATABASE_URL` (a throwaway Postgres with the schema pushed; it writes rows and removes its own), both wasm files, drand. Local sandbox: one owner with two vaults, both registered through the API, one tester key per vault, one tester cycle, then the second vault's key removed and only that vault stops. Ends `PASS: multi-vault checks held` (23 checks on 2026-11-13) |
| `scripts/keeper.ts` | `KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY` (any funded testnet account) |
| `scripts/verify-evidence.ts` | Nothing secret: `NEAR_NETWORK`, `NEAR_RPC_URL`, a vault id and a bundle. The public evidence route is paged (100 slots, `fromSlot`) and limited to 20 requests a minute; the script follows `next_from_slot` and waits on a 429. Old txs need an archival RPC (`https://archival-rpc.testnet.fastnear.com`). A vault passes provenance only if it was created, given global code by hash and initialized in one tx by its parent (V21-04); classic vaults such as shop2 and shop3 need `--allow-unattested`, shop4 (global) passes without it (150 checks on 2026-11-12, includes the bundle status check); the sandbox needs `--init-tx <hash>@<signer>` |
| `scripts/attack-demo.ts`, `k2-pay.ts` | The agent's private key for the vault (`AGENT_PRIVATE_KEY`). Run only against your own vault |
| `scripts/pass-rate.ts` | `NEARAI_API_KEY_AGENT` via `bun --env-file=../agent/.env`; about 23 min and 149 model calls for 7 models x 5 trials; writes `scripts/out/pass-rate.{md,json}` (committed runs are in `backend/data/model-runs/`). `--lures fixtures/b1-tests-layout.json` runs the generated B1 lures instead, one vault per model (2026-11-11: 2 models x 41 trials, 374 calls, about 1 h) |
| `scripts/k3-generator.ts`, `b1-blind.ts`, the tester process | `NEARAI_API_KEY_TESTER`; the tester also needs `TEST_SEAL_KEY`, the owner FC key (`commit_batch`, `reveal`, `release`, `prove_delivery`) and Postgres |
| API (`backend/index.ts`) | See `backend/.env.example`. Also optional `ONECLICK_JWT` and `ONECLICK_API_URL` for `GET /public/quote`, and the multi-vault settings below |
| Tester (`backend/tester.ts`) | See `backend/.env.tester.example`. Serving self-serve vaults also needs `TESTER_KEY_SEED` (secret, 64 hex chars); without it the tester serves the default vault only. Rotating it changes every self-serve vault's tester key, and each owner must re-add the new key |
| Agent (`agent/index.ts`) | See `agent/.env.example`. Also optional `AGENT_PAY_INTENTS_TGAS` (default 150) for Intents pays |
| MCP server (`agent/mcp.ts`, `bun run mcp`) | The agent's `AGENT_*`, `INBOX_*`, `NEAR_*` settings and its key; no NEAR AI key. Optional `MCP_STATE_PATH` (pid-locked), `MCP_DECISION_TIMEOUT_S` (1800), `MCP_MAX_TOOL_CALLS_PER_INVOICE` (20), `MCP_MAX_RESULT_BYTES` (45000), `MCP_PREFLIGHT` (`enforce`, or `advisory` to measure the bare model), `MCP_ALLOW_CONCURRENT`. Run it instead of `index.ts`, never both on one key |

The `.env*.example` files are protected by a hook and may lag the code: `ONECLICK_JWT`, `ONECLICK_API_URL`, `AGENT_PAY_INTENTS_TGAS`, `NEARAI_TIMEOUT_S` (tester, default 900: deadline per NEAR AI call including verification; a reasoning draft took 150 to 300 s on 2026-11-11) and `GENERATOR_THINKING` (tester, `on` by default as measured by B1, `off` sends `chat_template_kwargs.enable_thinking=false` and drafts in about 10 s) are not in them yet, nor are the 2026-11-12 additions `ALERT_WEBHOOK_URLS`, `ALERT_WEBHOOK_SECRET`, `ALERT_POLL_SECONDS`, `ALERT_TIMEOUT_MS`, `VAULT_CODE_HASH`, `VAULT_DEFAULT_TOKEN_ID`, `VAULT_PLAN_MAINNET` (API) the `MCP_*` settings (agent), and the multi-vault settings: API `MAX_COMPANIES_PER_USER` (5), `TESTER_MAX_VAULTS` (10), `TESTER_MAX_BATCH_SIZE` (10), `TESTER_ALLOWANCE_YOCTO` (1 NEAR), `TESTER_MIN_ALLOWANCE_YOCTO` (0.1 NEAR), `BLOCKLIST_TRUSTED_VAULTS` (default `SHOP_CONTRACT_ID`), `INDEXER_VAULTS_PER_TICK` (4), `INDEXER_SPANS_PER_TICK_OTHER` (2); tester `TESTER_KEY_SEED`, `TESTER_MAX_LURES_PER_BATCH` (3), `TESTER_MAX_LURES_PER_DAY` (30), plus its own `TESTER_MAX_VAULTS`, `TESTER_MAX_BATCH_SIZE` and `TESTER_MIN_ALLOWANCE_YOCTO`, which must equal the API's in `.env`; `backend/.env.tester.example` still lists the tester key methods as `commit_batch` and `reveal` only. The config sources (`backend/src/config/main-config.ts`, `backend/src/tester/config.ts`, `agent/src/config.ts`) are authoritative.
