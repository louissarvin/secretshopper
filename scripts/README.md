# Scripts (scripts/)

Bun scripts that run Secret Shopper end to end on a local NEAR sandbox, check a live vault from chain and drand alone, create vaults, run the keeper, and produce the evidence linked from the main docs. Each script documents its own usage and env in its header comment, which is the source of truth for flags.

- What the product is and why: [../README.md](../README.md)
- Every test and what it proves, plus what needs secrets: [../AGENTS.md](../AGENTS.md)
- Full demo output and what is real versus stand-in: [demo.md](demo.md)

Install once from the repo root with `bun run setup` (installs `backend/`, `agent/` and `scripts/`). Bun 1.4.4 or newer.

## Start here

Three commands, no account, key, API token or database.

**1. Everything that needs no secret** (about 6 minutes; builds the contract, runs Rust, backend and agent tests, clippy, typechecks, lint and the demo):

```bash
bun run setup && bun run verify          # from the repo root; flags: --skip-contract, --skip-demo
```

Expected last line (AGENTS.md, 2026-11-11):

```
VERIFY PASS: 12 steps passed, 0 skipped.
```

**2. The end-to-end demo** (about 60 seconds, needs the two wasm builds and access to `api.drand.sh`):

```bash
(cd contracts/shop && cargo near build non-reproducible-wasm)
(cd contracts/shop/tests/fixtures/ft && cargo near build non-reproducible-wasm --no-abi)
bun run demo
```

Expected last line ([demo.md](demo.md), 2026-11-10; the time varies):

```
PASS: all 33 checks held in 60.9s.
```

**3. Re-check the live testnet vault** from chain, drand and its public evidence bundle:

```bash
cd scripts
NEAR_NETWORK=testnet NEAR_RPC_URL=https://archival-rpc.testnet.fastnear.com \
  bun verify-evidence.ts shop4.ss-owner-e9c3db.testnet <api>/public/evidence/shop4.ss-owner-e9c3db.testnet
```

`<api>` is the base URL of a running Secret Shopper API for that vault. Expected last line (141 passing checks on 2026-11-12, no `--allow-unattested`):

```
ALL CHECKS PASSED
```

Without a running API, the committed bundles work offline as the bundle source: `bun verify-evidence.ts shop4.ss-owner-e9c3db.testnet evidence/shop4.ss-owner-e9c3db.testnet.json`, or `bun verify-evidence.ts shop2.ss-owner-e9c3db.testnet evidence/shop2.ss-owner-e9c3db.testnet.json --allow-unattested` with the same env (shop2 is a classic 2.0.0 deploy, so its provenance cannot be attested).

## Script catalogue

Needs: **nothing** (local only), **network** (public RPC, drand, FastNEAR or 1Click), **owner key** (`~/.near-credentials/<network>/<owner>.json`), **agent key** (`AGENT_PRIVATE_KEY`), **NEAR AI key**, **DB** (Postgres, directly or through a running API). Scripts on the local sandbox also need the wasm builds; the sandbox binary (about 70 MB) is downloaded on first use.

| Script | What it does | Needs | Writes | Evidence produced |
|:-|:-|:-|:-|:-|
| `demo.ts` (`bun run demo`) | Full v2 loop on a local sandbox: global contract publish, one-tx vault, gas-key arming, tlock commit, release and ack, lure paid, reveal, demotion, keeper reveal, verifier, tampered bundle. Exit 0 only if every check holds | Network (drand). Optional NEAR AI key (`NEARAI_API_KEY_AGENT`) swaps the naive agent for a live model | `out/demo-evidence.json`, `out/demo-evidence-tampered.json` | [demo.md](demo.md); with `z-ai/glm-5.3-flash` on 2026-11-10: `PASS: all 24 checks held` ([README, Live evidence](../README.md#live-evidence)) |
| `mcp-e2e.ts` | An external agent through the MCP server on a local sandbox: spawns the real `bun agent/mcp.ts` over stdio and drives it with the official MCP client (`@modelcontextprotocol/client` 2.4.0) as a scripted agent that pays every invoice as written. The inbox stand-in serves `/inbox/next`, `/inbox/vendors/:id` and `/inbox/blocklist/:accountId` with the backend's shapes and bearer check. Part 1, `MCP_PREFLIGHT=enforce`: the genuine invoice is paid, the lure pay is refused by the preflight and nothing is signed. Part 2, a fresh server with `MCP_PREFLIGHT=advisory` on the same state file: the same lure is paid through MCP (result `preflight: block`, `overridden: true`, tx hash), the tester's reveal is `Failed`, the key is rewritten to `propose,decline,ack`, and the tester's blocklist code lists the lure payee with the reveal tx as evidence (checked by the backend's evidence rule). `check_account` then shows the entry, MCP refuses `pay`, a direct `pay` with the key fails in the runtime (`AccessKeyMethodNameMismatch`), and an advisory `propose` to the same payee signs with `blocklisted` in `preflight_reasons`; the owner rejects it. Part 3, enforce again: a `propose` to the blocklisted payee is refused with `blocklisted` and nothing signed, the genuine `propose` signs and the owner approves; the first tick is acked. Exit 0 only if every check holds | Network (drand). The two wasm builds | Nothing (temp state dir, removed) | Ends `PASS: all 46 checks held` (about 21 s) |
| `verify-all.ts` (`bun run verify`) | Runs the 12 secret-free steps with `NEARAI_API_KEY_AGENT` forced empty, prints a table. Exit 0 only if all pass. `--record` also writes the tracked `../backend/data/verify-report.json`, only when all 12 pass with none skipped | Rust toolchain, network (drand for the demo step) | `out/verify-report.json`, one log per step in `out/verify/`; with `--record`, `../backend/data/verify-report.json` | [../backend/data/verify-report.json](../backend/data/verify-report.json) |
| `verify-evidence.ts` | Independent verifier: provenance, key scope, commitments, tlock ciphertexts, AI receipts, timeline, scorecard, and each bundle slot status against the chain. Exit code = number of failures, 100 if drand is unreachable | Network (RPC, drand, FastNEAR tx API) | Nothing | shop4: 20 checks at creation, then 78, 109 and 141 after each batch, all `ALL CHECKS PASSED` ([README, Live evidence](../README.md#live-evidence)) |
| `create-vault.ts` | Creates a vault in one tx from a published global contract (`--code-hash`) or with a self-deleting one-time key (`--wasm`), registers it on the token, then inspects it. Dry run unless `--send` | Network; owner key for `--send` | Nothing (prints tx links) | shop4 [5dgatWYd...](https://testnet.nearblocks.io/txns/5dgatWYdyWeDUm216gMi5CWNiSdtu3xrNML9zXpNCopq) (global, 654 B stored), shop3 [BtG936cM...](https://testnet.nearblocks.io/txns/BtG936cMZy26jhj2gCTQR1cCyPDUmo79PGDrPN7h1yzv) (classic, 336743 B) |
| `global-vault.ts` | On a local sandbox: publishes the wasm by hash, compares a classic and a global vault (storage, keys, break-even), checks that only the parent can init and that only the one-tx global vault is attested | Nothing | Nothing | Ends `PASS: global vault checks held`; [README, Claims](../README.md#claims-and-how-to-check-them) row 3 |
| `attack-demo.ts` | Prompt-injected agent tries to pay an attacker. Phase A (Armed): over `max_per_payment`, refused by the contract. Phase B (Demoted): refused by the runtime with `MethodNameMismatch`. `--phase=a\|b\|all` | Agent key, network. Optional NEAR AI key shows the model's own reaction | Appends to the log file in `ATTACK_LOG` | shop2 phase A: `amount out of bounds`; shop4 phase B: `AccessKeyMethodNameMismatchActionError` ([README, Live evidence](../README.md#live-evidence)) |
| `keeper.ts` | Reveals slots without the owner: reads ciphertexts from commit tx args, checks their sha256, waits for the drand round, decrypts, checks the commitment, calls `reveal`. Exit 1 on owner sabotage. `--commit-tx`, `--once`, `--interval-s` | Network; any funded account key (`KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY` or legacy keychain) | Nothing (JSON log lines on stdout) | shop2 slots 0 and 2 revealed `Void` by `ss-vendor-e9c3db.testnet` ([README, Live evidence](../README.md#live-evidence)) |
| `unit-cost.ts` | Measured cost of running a vault, read-only: tokens_burnt of every tx to the vault by type, gas-key balances destroyed by DeleteKey on demotion and re-arm (archival RPC), storage added per commit and reveal, lure generation from the usage in published NEAR AI receipts times `GET /v1/model/list` prices; per slot, batch, day, failure and agent decision, every tx hash cited. Markdown on stdout. `--near-usd <n>` (no NEAR price is fetched), `--evidence`, `--out` | Network (FastNEAR tx API, archival RPC, NEAR AI model list); the vault's evidence bundle (`--evidence`, published bundles in `evidence/`) | `--out` file, else stdout | shop4 on 2026-11-12: [README, What it costs](../README.md#what-it-costs) |
| `ledger-csv.ts` | Accountant's CSV of payments, proposals, declines and test slots from on-chain events. `--out`, `--from`, `--to`. Testnet or mainnet only | Network (FastNEAR tx API, RPC) | `--out` file, else stdout | None committed |
| `intents-quote.ts` | One 1Click dry payout quote (`dry: true`, nothing signed, no deposit address), or `--list [chain]` of destination assets | Network (1Click). Optional `ONECLICK_JWT` | Nothing | None committed |
| `api-smoke.ts` | Read-only checks of every web-app route against the chain: paging, hidden lures, CORS, security headers, 400/401/404/409/422 paths, the self-serve plan and vault view. `--owner` signs in with NEP-413 and reads owner routes and the alert feed; `--vendor` does the same for the vendor console. Exit code = failed checks | Running API with its DB; owner key for `--owner`, vendor key for `--vendor` | Nothing | [../backend/API.md](../backend/API.md) (59 checks against shop4 with both flags, 2026-11-12) |
| `selfserve-e2e.ts` | Asks the API for a self-serve vault plan and signs exactly those transactions, mapping each NEAR Connect action one to one as a wallet would, then reads the vault back. Testnet only | Running API; owner key | A new vault `<name>.<owner>` (about 1 NEAR) | `selfserve-e2e.ss-owner-e9c3db.testnet` ([7vYxmKPM...](https://testnet.nearblocks.io/txns/7vYxmKPMqqtwisJ97DGTsYZFTbnWTwYnDSd8gXiHzYe1)), `verify-evidence` `ALL CHECKS PASSED` |
| `pass-rate.ts` | Per-model pass rate: fresh lure plus a genuine invoice through the real agent loop, tools, preflight and vault on a sandbox. `--models`, `--trials`, `--max-calls`, `--seed`, `--lures`, `--stratified`, `--policy strict\|realistic` (realistic: a payee not yet approved may be paid and the preflight is advisory), `--parallel`, `--resume` (the output is saved after every trial), `--out`, `--dry` | NEAR AI key (`NEARAI_API_KEY_AGENT`); `--dry` needs nothing | `out/pass-rate.json` and `.md` (or `--out`) | [`../backend/data/model-runs/`](../backend/data/model-runs/): `pass-rate-2026-11-10.json` (7 models x 5), `pass-rate-generated-2026-11-11.json` (2 models x 41 generated lures), `pass-rate-realistic-2026-11-12.json` (realistic policy) |
| `b1-generate.ts` | Generates the test half of the B1 blind corpus through the real tester generator; saves every NEAR AI call with receipt and attestation. Resumable with `B1_RESUME=1` | NEAR AI key (`NEARAI_API_KEY_TESTER`) | `fixtures/b1-tests.json`, `out/b1-generate-receipts.json` (paths set by env) | `fixtures/b1-tests.json`, `fixtures/b1-tests-layout.json` |
| `b1-blind.ts` | Asks a judge model to tell generated tests from real items; accuracy, Wilson 95% interval, AUC. Pass: accuracy at most 0.60 and AUC at most 0.65 | NEAR AI key (`NEARAI_API_KEY_TESTER`) | `out/b1-receipts.json`, `out/b1-receipts.scores.json` | [`../backend/data/b1-summary.json`](../backend/data/b1-summary.json): n 99, accuracy 0.586, AUC 0.633 (2026-11-11, vendor layouts); the earlier rerun after the generator fixes gave 0.515 and 0.507 |
| `b1-validate.ts` | Offline check of the real B1 fixtures: intake schemas, vendor shape, payee rules per set (R1 25, R2 15, R3 10), invoice arithmetic, no banned wording | Nothing | Nothing | `fixtures/b1-real.json`, `fixtures/b1-sources.md` |
| `k2-pay.ts` | K2: the armed vault pays a never-existing implicit account twice; checks the payee balance and that only one storage deposit is spent. Spends tokens | Agent key, network | Nothing (prints JSON with tx links) | None committed |
| `k3-generator.ts` | K3: one test generation through NEAR AI with a verified receipt and its attestation | NEAR AI key (`NEARAI_API_KEY_TESTER`) | `../backend/test/fixtures/receipt-k3.json` (re-checked offline by `receipt.verify.test.ts`) | That fixture |
| `k5-agent.ts` | K5: read-only; prints the on-chain decision and payee record for each id in `INVOICE_IDS` | Network | Nothing | None committed |
| `live.ts` (`bun run live`, `bun run live:preflight`) | Preflight of the three env files (values never printed), vault, keys, tester key methods and DB roles, then starts API, tester and agent; one exiting stops the others. The agent never starts without `NEARAI_API_KEY_AGENT` | Owner FC key, agent key, NEAR AI keys, DB (through `backend/.env`, `backend/.env.tester`, `agent/.env`) | Nothing | None committed |
| `owner-register.ts` | Registers the vault's company in the local API: NEP-413 sign-in, then `POST /company` with the deploy block from FastNEAR. Idempotent | Owner key, running API with its DB | Nothing local | None committed |
| `owner-payees.ts` | Creates three fictional vendor payee sub-accounts of the owner, `add_payee` on the vault, mirrors each as a Vendor row. Idempotent. Signs txs | Owner key, running API with its DB | New payee keys to `~/.near-credentials/<network>/<payee>.json` (mode 0600; refuses to overwrite) | None committed |
| `evidence-export.ts` (`bun run evidence:export`) | Saves `GET /public/evidence/:shop` so verifiers do not depend on the server; prints the file's sha256 | Running API | `evidence/<shop>.json` | [evidence/shop4.ss-owner-e9c3db.testnet.json](evidence/shop4.ss-owner-e9c3db.testnet.json), [evidence/shop2.ss-owner-e9c3db.testnet.json](evidence/shop2.ss-owner-e9c3db.testnet.json) |

`fixtures/policy-testnet.json` is the policy file for `create-vault.ts --policy` (gas key with 4 lanes, `min_answer` 4 h, `test_ttl` 12 h).

## The demo in 24 steps

Condensed from [demo.md](demo.md) and the README Quickstart. Tx hashes, slot order, drand rounds and timings change every run.

| Step | What happens | What you see |
|:-|:-|:-|
| 1 | Accounts created; tUSDC deployed | Owner, agent vendor, supplier Acme, unrelated keeper account |
| 2, 3 | Vault wasm published once as a global contract by hash; the owner creates, attaches and inits the vault in one tx | `global_contract_hash equals the built wasm (618 B stored)` |
| 4, 5 | Vault funded with 20 tUSDC; tester FC key added on the owner (`commit_batch`, `reveal`, `release`, `prove_delivery`) | `list-keys shop.owner.sandbox: (no keys)` |
| 6 | Owner approves Acme as a payee on chain | `get_payees` lists only Acme |
| 7, 8 | Owner proposes, vendor accepts the agent key: a gas key with 4 lanes and 0.25 NEAR | `GasKeyFunctionCall(... methods=pay, decline, ack)`, mode `Armed` |
| 9 | Tester commits 3 slots (1 lure, 2 voids) with tlock ciphertexts in the tx args | `tlock round ... opens after expiry` |
| 10 to 12 | Lure and genuine invoice delivered; tester posts the tick's Merkle root; the agent recomputes it and acks | `release_posted`, `the agent ack matches the tester root` |
| 13 | `listed_only=true` pay to the lure payee | `payee is not listed`; preflight `block` |
| 14 to 16 | Naive agent pays the lure on its own gas; tester reveals `Failed`; same receipt demotes the key | `the agent decision cost the vault no gas`, `agent_demoted`, `methods=propose, decline, ack` |
| 17 | Same key calls `pay` again | `AccessKeyMethodNameMismatchActionError` |
| 18, 19 | Demoted agent proposes the genuine invoice; owner approves | `Acme received 1.20 tUSDC` |
| 20, 21 | Tester switched off; after expiry `keeper.ts` reveals the voids as an unrelated account | `two Void slots, both revealed by the keeper account` |
| 22, 23 | `verify-evidence.ts` checks chain + drand + bundle; then a bundle with one invoice line edited | `ALL CHECKS PASSED`, then `FAIL 3 slot 0 invoice_id = sha256(canonical(document))` |
| 24 | Final scorecard from the contract | `failed 1, demotions 1, mode Demoted, score 0%` |

Real: the compiled 2.3.0 vault, NEP-611 gas key, tester commitment, seal, tlock and reveal code from `backend/src/tester` and `backend/src/lib/proof`, the Merkle trees of backend and agent, the agent's tools and `get_vendor`, the evidence builder used by `GET /public/evidence`, and `keeper.ts` and `verify-evidence.ts` run as separate processes. Stand-in: tUSDC for USDC, an in-memory inbox instead of the Postgres one, a fixed scripted lure (so `receipt_hash` is 64 zeros and the verifier says so), and the labelled NAIVE AGENT (no LLM) unless `NEARAI_API_KEY_AGENT` is set. The `Ignored` delivery path is covered by the sandbox tests, not the demo.

## verify-evidence

```
bun verify-evidence.ts <shop> <bundle.json | https://.../public/evidence/<shop>> [--init-tx <hash>@<signer>] [--allow-unattested]
```

The bundle is never trusted for anything the chain can say. A URL source is followed page by page (`next_from_slot`, 100 slots a page) and waits out a 429. Env: `NEAR_NETWORK`, `NEAR_RPC_URL` (archival for old txs).

| Label | Checks |
|:-|:-|
| (none) | The bundle names this vault |
| 1 | No full-access key on the vault (`GasKeyFullAccess` and unknown kinds count as full access); every key is an agent scope on the vault (`pay,decline` or `propose,decline`, plus `ack` from 2.3.0) |
| 0 | Provenance (V21-04): the creation tx is exactly CreateAccount, Transfer, UseGlobalContract(hash), FunctionCall `new`, signed by the parent, successful, with an `initialized` event matching `get_status`; the attached hash equals the code the vault runs now. Implicit and `0s` accounts are never attested |
| 3 (batch) | Each commit tx is a successful owner call to this vault; ciphertexts come only from its args |
| 4 | Per slot: tlock round opens after expiry and within `reveal_grace`; ciphertext published in the commit tx; its sha256 matches chain; once the round is public, it opens to the committed preimage (else `OWNER SABOTAGE`) |
| 2 | Per revealed slot: the chain's reveal recomputes the commitment; the bundle preimage equals it |
| 3 | `invoice_id = sha256(canonical(document))`; AI receipt present, bytes match signed text and signer, signer is the key in the stored attestation, `receipt_hash = sha256(signed_text)`, the response names the payee. The bundle's own assurance label is ignored and recomputed |
| 5 | Delivery timeline: delivered after commit and before expiry; the on-chain decision came after delivery |
| 6 | Every revealed test receipt is in its batch's published generation log |
| 7 | Every scorecard stat recomputed from slots; `releases_posted`, `acks_matched`, `acks_mismatched` present from 2.3.0; pending + overdue = unrevealed; `score_bps = passed / (passed + failed + failed_contained + ignored)` |

Flags: `--init-tx <hash>@<signer>` supplies the creation tx when the FastNEAR tx API cannot find it (the sandbox). `--allow-unattested` turns a failed provenance check into a `WARN` (classic vaults such as shop2 and shop3). Exit code is the number of failed checks, or 100 when drand is unreachable, since a network fault proves nothing either way.

## Safety

- `create-vault.ts` is a dry run unless `--send`, and refuses mainnet without `--mainnet`. It also refuses, before signing: a policy the contract or tester would reject (`batch_size` below 1, `reveal_grace` under 9 s, `max_per_payment` above `daily_cap`, a zero `key_allowance` or one above half of `min_near_float`, `min_near_float` under 0.1 NEAR, `key_nonces` outside 0 to 64, a gas-key allowance above 1 NEAR, `min_answer` missing or outside `test_ttl / 4` to below `test_ttl`); `--intents` other than `intents.near` on mainnet, or any `--intents` on testnet without `--allow-unverified-intents`; an Intents account that does not exist; a vault id that exists or is not a direct sub-account of the owner; an unpublished global code hash; a missing vendor; a token with no `ft_metadata`; funding below the minimum; an owner balance under the funding plus 0.05 NEAR; and passing both or neither of `--code-hash` and `--wasm`.
- `create-vault.ts` is the only script with a mainnet gate. `keeper.ts`, `k2-pay.ts`, `attack-demo.ts`, `owner-register.ts` and `owner-payees.ts` sign on whatever `NEAR_NETWORK` names. Leave it at `testnet`; never sign on mainnet without the human's confirmation (AGENTS.md).
- `attack-demo.ts` and `k2-pay.ts` sign with the vault's agent key. Run them only against your own vault. `attack-demo.ts` aborts unless `AGENT_PRIVATE_KEY` is the vault's armed agent key; `k2-pay.ts` requires mode `Armed` and the vault's token and moves real tokens.
- Keys come from env or `~/.near-credentials`, never argv. `lib/creds.ts` warns when a key file is readable by other users. `live.ts`, `api-smoke.ts`, `owner-register.ts` and `owner-payees.ts` never print key material or the JWT.
- `verify-all.ts` blanks `NEARAI_API_KEY_AGENT` for every step, so it cannot spend on NEAR AI.

## lib/

| File | What it provides |
|:-|:-|
| `net.ts` | `NEAR` network config from `backend/src/config/network.ts` (testnet unless `NEAR_NETWORK=mainnet`), a retrying `provider`, `view`, `txUrl`, `req` (exits on a missing env var) and `errorText` |
| `creds.ts` | `credentialPath` and `loadLegacyKey` for the near-cli keychain `~/.near-credentials/<network>/<account>.json`; validates the ed25519 key, warns if the file is not 0600, never logs it |
| `owner.ts` | `api` (JSON envelope client for `API_URL`, default `http://localhost:3700`) and `signIn`: NEP-413 through `/auth/nonce` and `/auth/verify` with a full-access key, returns the JWT |
| `chainread.ts` | Raw chain reads with no backend: `rpc`, `txView`, `attestVault` (V21-04 provenance), `commitCallFromTx` (optionally requiring a successful owner call to the vault), `discoverCommitCalls` and `vaultEvents` through the FastNEAR tx API (retries 429 and 5xx), `chainNowMs` (final block time, so expiry is judged by chain time) |
| `vault-deploy.ts` | `Policy` and `VaultInit` types, `checkPolicy`, `checkIntents`, `minFunding` (storage + float + gas-key arming + 0.1 NEAR headroom), `gasKeyCost`, `createVault` (global one-tx or classic one-time key), `inspectVault`, `globalCodePublished` |
| `sandbox.ts` | `tearDownSandbox`: near-sandbox's teardown sends SIGTERM and waits without limit, and a busy nearcore 2.14.0 can ignore it, so it sends SIGKILL after a 20 s grace. Used by `demo.ts`, `global-vault.ts` and `pass-rate.ts` |
