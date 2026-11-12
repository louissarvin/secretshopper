# Design notes and audits (v2/)

The written history of Secret Shopper: the spec it started from, the design changes since, the build log, cost measurements, reviews against the official docs, and seven security audits. Files are dated and kept as written; where a design note and the code disagree, the code and [AGENTS.md](../AGENTS.md) are current. Back to the [project README](../README.md).

## Spec and design

| File | What it covers |
|:-|:-|
| [16a_secret_shopper_research.md](16a_secret_shopper_research.md) | Mechanism, anti-cheat and architecture (2026-10-26) |
| [16b_secret_shopper_build.md](16b_secret_shopper_build.md) | The original build spec: contract, backend, tester, agent, web (2026-10-26) |
| [19_testnet_path.md](19_testnet_path.md) | The path to NEAR testnet: accounts, token, deploy, locking the vault (2026-10-31) |
| [24_contract_v2_design.md](24_contract_v2_design.md) | Vault v2: receipt-bound commitments, tlock ciphertexts on chain, on-chain approved payees (2026-11-01) |
| [26_cost_profile.md](26_cost_profile.md) | Gas and storage per method for v2 (2026-11-01) |
| [31_intents_rail_notes.md](31_intents_rail_notes.md) | The NEAR Intents payment rail and the 1Click dry quote (2026-11-10) |
| [32_delivery_proof_design.md](32_delivery_proof_design.md) | Release roots, agent acks and Merkle proofs that close V2-02 in 2.3.0 (2026-11-10) |

## Build log and reviews

| File | What it covers |
|:-|:-|
| [20_backend_build_log.md](20_backend_build_log.md) | Every build and test run of the backend, tester and agent, with output |
| [28_near_docs_contract_review.md](28_near_docs_contract_review.md) | The contract and deploy tooling checked against the official NEAR docs |
| [29_partner_docs_backend_review.md](29_partner_docs_backend_review.md) | The backend and agent checked against NEAR AI, Intents and other partner docs (2026-11-06) |

## Security audits

All by an AI security-auditor agent with exploit tests, not by a human firm. Every fixed finding has a regression test.

| File | Scope | Result |
|:-|:-|:-|
| [21_security_audit.md](21_security_audit.md) | Contract v1, backend, agent | 1 High, 6 Medium, 8 Low; backend SS-B01 to SS-B07 fixed with inverted-PoC tests |
| [25_security_audit_v2.md](25_security_audit_v2.md) | Contract 2.0.0, with the fix table through 2.3.0 | No finding open; V2-02 closed by the delivery proof |
| [27_security_audit_v2_1.md](27_security_audit_v2_1.md) | Contract 2.1.0 | No Critical or High; V21-01 to V21-06 fixed (`tests/audit_v21.rs`) |
| [33_audit_230.md](33_audit_230.md) | Contract 2.3.0: gas keys and delivery proof | No Critical or High; V23-01 accepted; V23-13, V23-14 (Info) open |
| [34_backend_audit_230.md](34_backend_audit_230.md) | Backend for 2.3.0: delivery proof, public reads, quote proxy, generator | No Critical or High; fixed except B23-08 (by design) |
| [35_agent_audit.md](35_agent_audit.md) | Agent harness | No Critical or High; AG-01 to AG-08 fixed, AG-09 and AG-10 by design |
| [36_audit_new_features.md](36_audit_new_features.md) | Self-serve vault, vendor console, alerts, bring-your-own-agent MCP server | No Critical or High; NF-01 to NF-09 and NF-11 fixed the same day, NF-10 (Info) open |
