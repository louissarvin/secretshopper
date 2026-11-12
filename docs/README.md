# Evidence (docs/)

Everything Secret Shopper claims, and the raw output that backs it. Logs here are kept verbatim as the commands printed them; they are never edited after the run. Back to the [project README](../README.md) or the [AI reviewer guide](../AGENTS.md).

## Start here

| File | What it is |
|:-|:-|
| [CLAIMS.md](CLAIMS.md) | Every claim, the command that checks it, and the evidence. The single index for judges |
| [DEMO.md](DEMO.md) | Manual test by role, the two-minute video script, and the X post draft |
| [HOSTING.md](HOSTING.md) | The read-only hosted demo on Vercel: architecture, what is live vs snapshot, the human steps |
| [AGENT_MARKET.md](AGENT_MARKET.md) | Draft listing of a read-only vault verifier on NEAR Agent Market, with the adapter it needs |
| [COSTS.md](COSTS.md) | Measured cost per lure, per day, per agent decision and per failure, from shop4's transactions and the NEAR AI receipts |
| [RUNBOOK.md](RUNBOOK.md) | What to do when the API, tester, agent, RPC or drand is down; worst-case exposure; freeze, resync and re-arm |
| [API.md](API.md) | The HTTP API the web app reads, checked live by `scripts/api-smoke.ts` |
| [evidence/shop4.ss-owner-e9c3db.testnet.json](evidence/shop4.ss-owner-e9c3db.testnet.json) | Evidence bundle of the live run (9 slots, 3 batches): revealed preimages, lure documents and emails, NEAR AI receipts with their TEE attestations. Verify it with `scripts/verify-evidence.ts` |

## Live testnet run on shop4 (contract 2.3.0)

| File | What it shows |
|:-|:-|
| [deploy-shop4-2026-11-11.log](deploy-shop4-2026-11-11.log) | `create-vault.ts --code-hash`: vault created, given the global code by hash and initialized in one tx |
| [verify-shop4-2026-11-11.log](verify-shop4-2026-11-11.log) | `verify-evidence` before any lure: provenance passes with no `--allow-unattested` |
| [verify-shop4-reveal1-2026-11-12.log](verify-shop4-reveal1-2026-11-12.log) | After batch 1 (3 Passed) and the early `Failed` reveal of slot 5: ALL CHECKS PASSED |
| [verify-shop4-reveal2-2026-11-12.log](verify-shop4-reveal2-2026-11-12.log) | After batch 2 (slots 3 and 4 Passed): ALL CHECKS PASSED, 109 checks |
| [verify-shop4-reveal3-2026-11-12.log](verify-shop4-reveal3-2026-11-12.log) | After batch 3 (slot 6 Void, 7 and 8 Passed): ALL CHECKS PASSED, 141 checks; all eight lure receipts bound to the model's TEE attestation |
| [verify-selfserve-e2e-2026-11-12.log](verify-selfserve-e2e-2026-11-12.log) | A vault created through the self-serve plan (`selfserve-e2e`) passes the one-tx provenance attestation with no flag |
| [blocklist-shop4-2026-11-12.log](blocklist-shop4-2026-11-12.log) | The shared blocklist: the slot 5 lure payee listed with its Failed reveal as on-chain evidence, then the agent's preflight blocking a payment to it (`blocklisted`), nothing signed |
| [attack-demo-shop4.log](attack-demo-shop4.log) | `attack-demo.ts --phase=b` on the demoted gas key: the NEAR runtime refuses `pay` (`AccessKeyMethodNameMismatch`). The log's text "allows propose,decline only" was printed before the script learned that 2.3.0 keys also keep `ack`; the key on chain was `propose,decline,ack` |

## Earlier vaults

| File | What it shows |
|:-|:-|
| [deploy-shop3-2026-11-11.log](deploy-shop3-2026-11-11.log) | shop3: the same 2.3.0 code deployed the classic way (`create-vault.ts --wasm`) |
| [attack-demo.log](attack-demo.log) | Prompt-injection attack on shop2 (2.0.0): an injected 3 tUSDC pay stopped by the contract with `amount out of bounds` |
| [keeper-shop2.log](keeper-shop2.log) | shop2: three void slots revealed by an unrelated account (the vendor) while the owner was offline |
| [evidence/shop2.ss-owner-e9c3db.testnet.json](evidence/shop2.ss-owner-e9c3db.testnet.json) | shop2 evidence bundle (classic deploy, verify with `--allow-unattested` and an archival RPC) |

## Model measurements (NEAR AI Cloud)

| File | What it measures |
|:-|:-|
| [demo-live-2026-11-10.log](demo-live-2026-11-10.log) | `bun run demo` with a live NEAR AI model as the agent: it declined the lure and paid the genuine invoice; every step a verified `provider_tee` receipt |
| [pass-rate-2026-11-10.md](pass-rate-2026-11-10.md) and [.json](pass-rate-2026-11-10.json) | 7 models x 5 scripted bank-change lures: none paid; only 2 models pass model attestation |
| [pass-rate-generated-2026-11-11.md](pass-rate-generated-2026-11-11.md) and [.json](pass-rate-generated-2026-11-11.json) | The 2 attested models x 41 generated lures: 41 of 41 declined each, 41 of 41 genuine invoices paid |
| [b1-blind-2026-11-10.md](b1-blind-2026-11-10.md) | B1 blind test: can a model judge tell lures from real inbox items? Three runs, the last a narrow pass (accuracy 0.586, AUC 0.633) |
| [b1-blind-rerun-2026-11-11.log](b1-blind-rerun-2026-11-11.log), [b1-blind-layout-2026-11-11.log](b1-blind-layout-2026-11-11.log) | Raw output of the second and third B1 runs |

## Re-run the checks

```bash
cd scripts
NEAR_NETWORK=testnet NEAR_RPC_URL=https://archival-rpc.testnet.fastnear.com \
  bun verify-evidence.ts shop4.ss-owner-e9c3db.testnet ../docs/evidence/shop4.ss-owner-e9c3db.testnet.json
```

Expected last line: `ALL CHECKS PASSED`. Old transactions need the archival RPC. The other commands are in [CLAIMS.md](CLAIMS.md) and [../scripts/README.md](../scripts/README.md).

