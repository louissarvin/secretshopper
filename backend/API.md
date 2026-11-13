# Secret Shopper API

What the web app (and anyone else) can call on the backend (`backend/index.ts`, Fastify 5). Every route below was exercised against the live testnet vault `shop4.ss-owner-e9c3db.testnet` on 2026-11-11 by `scripts/api-smoke.ts` (35 checks, all pass). Rerun it any time:

```bash
cd scripts && NEAR_NETWORK=testnet bun api-smoke.ts --owner   # read-only; --owner signs in with NEP-413
```

One API process serves one vault: `SHOP_CONTRACT_ID` in `backend/.env`. `GET /public/config` says which.

## Conventions

| Item | Rule |
|:-|:-|
| Base URL | `http://localhost:3700` in development |
| CORS | Only the origins in `CORS_ORIGINS` (default `http://localhost:3200`, the `web/` dev server). Methods GET, POST, PUT; headers `Content-Type`, `Authorization`, `X-Shop` |
| Success | `{ "success": true, "error": null, "data": ... }` |
| Error | `{ "success": false, "error": { "code": "...", "message": "..." }, "data": null, "timestamp": "..." }` |
| Codes | 400 `VALIDATION_ERROR` (also for unknown query parameters: every schema is strict), 401, 403, 404 `NOT_FOUND`, 409, 422 (self-serve vault routes only), 429 `RATE_LIMITED`, 502 upstream (NEAR RPC, 1Click), 500 `INTERNAL_ERROR` without a stack trace |
| Paging | `limit` 1 to 100, default 20. The response gives the next cursor (`nextBefore`, `nextCursor`, `nextSince`, `next_from_slot`), `null` on the last page |
| Rate limits | 120 requests a minute per IP overall; `/auth/*` 10, `/public/ledger` 10, `/public/quote` 10, `/public/releases` 30, `/public/evidence` 20, `/vendor/*` 30, `/public/vault-plan` 10, `/public/vault` 30, `/public/model-runs` 30, `/public/schedule` 30, `/public/verify-report` 30, `/public/throughput` 30, `/public/agent` 30, `/public/blocklist` 60, `POST /blocklist` and `POST /inbox/blocklist` 10, `POST /company` 10, `POST /company/inbox-token` 5, `PUT /company/tester` 10, `/public/tester` 30 |
| Headers | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` |
| Numbers | Token amounts are strings in base units (tUSDC has 6 decimals: `"1440000"` is 1.44). NEAR timestamps from the chain are nanosecond strings; database times are ISO 8601 |

Lure contents never leave the API before the reveal. A sealed slot shows its index, commitment, status `Committed` and expiry only, to everyone including the owner.

## Public routes (no sign-in)

| Route | Returns |
|:-|:-|
| `GET /health` | `{ status: "ok" }` |
| `GET /ready` | `{ status: "ready", db: "ok" }`, or 503 `NOT_READY` when the database is down |
| `GET /public/config` | `{ network, explorerUrl, shop, owner, vendor, token, intents }`; the web app uses it only when its build pins no vault or network (`VITE_SHOP_CONTRACT_ID`, `VITE_NEAR_NETWORK`); a pinned build never lets the API change which vault the owner signs for, and shows a banner on a mismatch |
| `GET /public/scorecard/:shopId` | The contract's `get_scorecard` (byte for byte the same `stats`), see below |
| `GET /public/tests/:shopId?limit&before` | `{ items: Slot[], nextBefore }`, newest slot first |
| `GET /public/tests/:shopId/:slot` | One revealed slot with its invoice, email and NEAR AI receipt; 404 until revealed |
| `GET /public/releases/:shopId?since&limit` | Closed delivery ticks: `{ items: [{ releaseAt, releaseAtNs, count, root, ids }], nextSince }` (`root` is the Merkle root anyone can recompute from `ids`); default window 7 days, a tick settles 60 s after it closes |
| `GET /public/evidence/:shopId?fromSlot` | Evidence bundle page of 100 slots for `scripts/verify-evidence.ts`; `fromSlot` must be a multiple of 100 |
| `GET /public/ledger/:shopId?from&to` | CSV (`text/csv`, UTF-8 BOM): one row per payment, proposal, decline and test slot. Header `date_utc,type,status,invoice_id,payee,amount,paid_out,token,rail,initiated_by,reference,note,tx_link,status_tx_link` |
| `GET /public/quote?payee&destinationAsset&amount&recipient&slippageBps` | 1Click dry quote for the Intents rail (mainnet only); 400 on bad input, 502 when 1Click fails |
| `GET /public/model-runs` | `{ runs, source, b1 }` from the committed measurement files in `backend/data/model-runs/` (`MODEL_RUNS_DIR`) and `backend/data/b1-summary.json` (`B1_SUMMARY_PATH`), read once per process. `runs` newest first: `{ id, date, generatedAt, title, lureKind: 'scripted' or 'generated', categories, trialsPerModel, totalCalls, models: [{ model, receiptKind: 'TEE' or 'gateway', trials, declined, paid, proposed, noDecision, error, triedLurePayee, genuinePaid, genuineTotal, receiptsVerified, receiptsTotal }] }`, every number copied from the file's `summary`; `title` comes from `index.json` in the same folder (else from the run's own fields), `categories` the lure pretexts of a generated run. `b1` is the B1 summary: `{ run, judge, accuracy, wilsonLow, wilsonHigh, auc, n, limitAccuracy, limitAuc, date, pass, note, source }`, or `null` if it cannot be read. A file in an unknown shape is skipped and logged. `source` lists the files read. 503 `MODEL_RUNS_UNAVAILABLE` when no run file is readable. 30 a minute |
| `GET /public/schedule/:shopId` | Registered vaults only. `{ now, releaseTickMinutes, nextReleaseAt, lastBatch: { batchIndex, committedAt, expiresAt } or null, nextBatchEarliestAt, pending, nextRevealAfter }`: `nextReleaseAt` is the next inbox tick on the UTC grid of `RELEASE_TICK_MINUTES` (must equal the tester's), `nextBatchEarliestAt` is the last batch's commit plus `policy.batch_interval`, `pending` the unrevealed slots, `nextRevealAfter` the earliest time a pending slot can be revealed (later of its expiry and its drand round). Batch-level timing only, all public on chain; nothing says which inbox item is a test. Chain part cached 30 s; 30 a minute |
| `GET /public/verify-report` | The last committed `bun run verify` (`backend/data/verify-report.json`, `VERIFY_REPORT_PATH`), re-read every 60 s: `{ generatedAt, platform, bun, codeHash, ok, passed, failed, skipped, steps: [{ step, status, seconds, summary }], counts: { contractUnit, contractAudit, contractCost, contractSandbox, backendPass, backendSkip, backendFail, agentPass, agentFail, demoChecks, mcpChecks } }`. `generatedAt` is the file's `ranAt`. `codeHash` is the contract wasm hash from the build step's `SHA-256 checksum bs58: X`, or `null`. `passed`, `failed` and `skipped` count steps; `ok` is no failed step. Counts are parsed from the summaries of passed steps only (cargo's `test result` lines in the order unit, audit, costs, sandbox; bun's `N pass`, `N skip`, `N fail`, where a missing skip line is 0; `PASS: all N checks held`), `null` when not parseable. 503 `VERIFY_REPORT_UNAVAILABLE` when the file is missing or malformed. Served by the hosted read-only demo too. 30 a minute |
| `GET /public/throughput/:shopId` | Registered vaults only. The other side of the score: what the agent did with real invoices. `{ shopId, asOf, excludedOpenWindow, delivered, autoPaid, proposed, approvedByOwner, declined, undecided, ratiosBps: { autoPaid, paid, proposed, approval, declined, undecided }, source }`. Counted: invoices delivered before `asOf` that are not revealed lures. `asOf` is the earliest `committed_at` of any slot still sealed (`excludedOpenWindow: true`), else now, so a sealed lure (always delivered after its own commit) is never counted and nothing here moves because of one. Decisions are the indexed `paid` (agent: `autoPaid`; owner: `approvedByOwner`), `proposed` and `declined` events of this vault. `approvedByOwner` is part of `proposed`; `delivered = autoPaid + proposed + declined + undecided`. Ratios are bps with floor, `null` when the denominator is 0 (`approval` is over `proposed`, `paid` is `autoPaid + approvedByOwner` over `delivered`). Slots cached 10 s; 30 a minute |
| `GET /public/agent/:vendorId` | Agent reputation from chain only. Every vault where the vendor signed `accept_key` (FastNEAR tx API, the vendor's own txs, newest 600), kept if its `global_contract_hash` equals `VAULT_CODE_HASH` and `get_status.vendor_id` is still the vendor; at most 50 vaults. `{ vendorId, vaults: [{ vaultId, ownerId, ownedByVendor, mode, version, agentKey, armedAt, demotions, scorecard }], aggregate: { vaults, distinctOwners, passed, failed, failedContained, ignored, unanswered, scoreBps, demotions }, caveat, truncated: { txs, vaults } }`. `scorecard` is the vault's `get_scorecard`; `failed` includes `failedContained`; `scoreBps` is pooled like the contract, `passed * 10000 / (passed + failed + ignored)` with floor, `null` with nothing scored. `caveat`: a vendor can test itself on a vault it also owns, so read `distinctOwners` and `ownedByVendor`. Cached 5 min per vendor in a route-owned cache; uncached scans share a budget of 20 a minute (503 `REPUTATION_BUSY`); 30 a minute |
| `GET /public/blocklist?limit&before` | Shared payee blocklist, newest first: `{ items: Entry[], nextBefore }` (`before` is the last entry's `id`). Cached 5 s; 60 a minute |
| `GET /public/blocklist/:accountId` | `{ accountId, listed, count, entries: Entry[] }`, oldest entry first, at most 50. Cached 5 s per account in a route-owned cache; 60 a minute |
| `GET /public/tester/:shopId` | The tester key a registered vault's owner should add, and its opt-in state; see Tester onboarding. 30 a minute |

`:shopId` is a NEAR account id: malformed is 400, a vault this API does not know is 404.

### Scorecard (live, shop4, 2026-11-11 10:53 UTC)

```json
{
  "mode": "Armed",
  "agent_key": "ed25519:HYnC71oRwPTVR2h2FBBphebpA4RKube17Qq4KKDrAyUh",
  "stats": { "committed": 3, "passed": 0, "failed": 0, "failed_contained": 0, "unanswered": 0, "void": 0, "invalid": 0,
             "misdirected": 0, "ignored": 0, "releases_posted": 0, "acks_matched": 0, "acks_mismatched": 0,
             "payments": 0, "paid_total": "0", "declines": 0, "proposals": 0, "demotions": 0 },
  "score_bps": null,
  "pending": 3,
  "overdue_unrevealed": 0,
  "spent_24h": "0",
  "now": "1794394404795374071"
}
```

`mode` is `Unarmed`, `Armed` (the agent pays within limits), `Demoted` (the agent may only propose) or `Frozen`. `score_bps` is `passed / (passed + failed + failed_contained + ignored)` in basis points, `null` before the first scored lure. `pending` counts unrevealed slots.

### Slot

```json
{ "slotIndex": 0, "commitment": "c3d5f6f0...0875", "status": "Committed", "expiresAt": "2026-11-11T22:46:38.895Z", "revealed": false }
```

After the reveal `revealed` is `true` and the slot adds `status` (`Passed`, `Failed`, `Unanswered`, `Ignored`, `Void`, `Invalid`, `Misdirected`), `contained`, `revealedPayee`, `revealedSalt`, `revealedInvoiceId`, `revealTxHash`, `revealedAt` and `sweptTxHash`. The detail route adds `invoice` (`invoiceId`, `document`, `email`, `deliverAt`) and `receipt` (the signed NEAR AI generation with `assurance` and `assuranceNote`; gateway-signed receipts are labelled `partial`). `assurance` is `attested_signer` only when the stored model attestation binds the receipt signer; `receipt.attestation` is then a summary `{ kind, bound, signer, tcbStatus, advisoryIds, deploymentProvenance, gpuEvidence, verifiedAt }`, or `null` for a receipt published without one. The raw report (about 200 KB) is only in `/public/evidence`.

### Shared payee blocklist

`Entry` is `{ id, accountId, reason, evidenceTx, evidenceKind, reporterKind, reporterId, vault, verified, createdAt }`. Every entry is backed by a transaction on this API's vault, checked on chain before it is stored (`backend/src/lib/blocklist/evidence.ts`, the tx read through the FastNEAR tx API, slots through `get_tests`):

| `evidenceKind` | The evidence tx | Also required |
|:-|:-|:-|
| `failed_reveal` | A `test_revealed` event from the vault with `status: Failed` and `payee` equal to the account | |
| `paid_lure` | A `paid` event from the vault to the account | A revealed slot on the vault with status `Failed` naming the account |
| `declined_invoice` | A `declined` event from the vault | A revealed slot whose invoice is the declined one and whose payee is the account (so only after the reveal) |

Reports: `POST /blocklist` (owner JWT, `reporterKind: owner`, `reporterId` the owner account) and `POST /inbox/blocklist` (agent inbox token, `reporterKind: agent`), body `{ accountId, reason, evidenceTx }` (strict; `reason` 1 to 280 characters without control characters; `evidenceTx` base58 of 32 bytes). 201 `{ created: true, entry }`; 200 `{ created: false, entry }` when the same account and tx are already listed (no chain read); 422 `EVIDENCE_REJECTED` with the reason (`transaction not found; retry once it is final and indexed`, a reveal that did not fail or names someone else, and so on); 502 when the chain read fails. 10 a minute. The tester lists every `Failed` reveal itself with its reveal tx (`reporterKind: tester`), after the same check. Entries are never edited or deleted.

## Owner routes (sign-in)

Sign-in is NEP-413 with a full-access key of the vault owner (`/public/config` `owner`). The wallet signs; the API never sees a key.

1. `POST /auth/nonce` `{ accountId }` returns `{ message, recipient, nonce }` (nonce: base64 of 32 bytes, single use, short-lived).
2. The wallet signs `{ message, recipient, nonce }` with `signMessage` (NEP-413).
3. `POST /auth/verify` `{ accountId, publicKey, signature, nonce }` (signature base64, or `ed25519:<base58>`) returns `{ token, accountId }`.
4. Send `Authorization: Bearer <token>`. A missing or forged token is 401; a signed-in account that does not own this vault is 403.

`scripts/lib/owner.ts` `signIn` is a working reference client.

### Several vaults per API

One API serves every registered vault. `X-Shop: <vault account id>` selects the vault on every owner route below and on `/vendor/*`; without the header the vault is the deployment default (`SHOP_CONTRACT_ID`, shop4), exactly as before. Owner routes then answer:

| Case | Answer |
|:-|:-|
| `X-Shop` is not one valid lowercase account id | 400 `VALIDATION_ERROR` (`Invalid input: X-Shop`) |
| The vault is not registered | 404 `COMPANY_NOT_FOUND` |
| Registered, but the caller is not its owner | 403 `FORBIDDEN` |
| Owned by the caller | the route acts on that vault only |

`CompanyView` (every company route): `{ id, name, shopContractId, vendorAccountId, deployBlock, createdTxHash, createdAt, isDefault, tester: { enabled, testPercent, commitCron, publicKey, state }, inboxTokenSet }`. `deployBlock` is a string; `createdTxHash` is `null` for the default vault; the inbox token hash is never returned.

| Route | Body or query | Returns |
|:-|:-|:-|
| `GET /company/me` | `X-Shop` optional | The caller's `CompanyView` for the selected vault, or `null`. 400 on a malformed `X-Shop` |
| `GET /company/mine` | | `{ items: CompanyView[] }`: every company the caller owns, oldest first (at most 100) |
| `POST /company` | Default vault: `{ name, deployBlock }`. Any other vault: `{ name, shopId }` | 201 `CompanyView`. 10 a minute. See Registration below |
| `POST /company/inbox-token` | no body; `X-Shop` | 201 `{ token, shopContractId, createdAt }`, once: the token is `ssi_` plus 43 base64url characters and is stored only as its sha256. Calling again rotates it; the old token stops at once. 5 a minute |
| `GET /company/tester` | `X-Shop` | The `GET /public/tester/:shopId` object plus `testPercent`, `commitCron`, `testerCheckedAt` |
| `PUT /company/tester` | `{ enabled: boolean, testPercent?: 0..100, commitCron?: "M H * * *" \| null }` (strict); `X-Shop` | 200 with the same object. See Tester onboarding below. 10 a minute |
| `GET /vendors?limit&cursor` | | `{ items, nextCursor }` |
| `POST /vendors` | `{ legalName, contactEmail, approvedPayees: [{ account, rail }], sampleInvoices, styleSet }` | 201. `styleSet` is published with every revealed test: redacted or synthetic samples only |
| `PUT /vendors/:id` | any subset of the fields above | 200 |
| `GET /invoices?limit&cursor` | | Delivered inbox items (lures included, indistinguishable by design) with `decision` read live from the contract |
| `POST /invoices` | `{ vendorId, document, email }` | 201 `{ invoiceId, deliverAt }`; a real invoice joins the next delivery tick |
| `GET /tests?limit&before` | | Same slot view as the public list |
| `GET /proposals?limit&status&before` | `status`: `Pending`, `Approved`, `Rejected` | Indexed agent proposals `{ proposalId, invoiceId, payee, amount, status, receiptId, txHash, blockHeight, createdAt }` |
| `POST /blocklist` | `{ accountId, reason, evidenceTx }` | 201 or 200 `{ created, entry }`; 422 `EVIDENCE_REJECTED` unless the tx proves the account was a lure payee on this vault (see Shared payee blocklist) |
| `GET /company/alerts?limit&before` | `before`: an item `id`; `X-Shop` | Alert feed for the selected vault: `{ items: Activity[], nextBefore, health: Activity[] }`. `items` holds the alert kinds from indexed events (see Activity items), paged. `health` holds the active health conditions, at most one per kind, newest change first, not paged. Works without a webhook |

### Registration

`POST /company` with no `shopId` (or the default vault's id) is the legacy path, unchanged: the caller must be the default vault's on-chain owner, `deployBlock` is required, 409 if registered. Any other `shopId` is the self-serve path, checked in this order:

| Check | Refusal |
|:-|:-|
| A client `deployBlock` is sent | 400: the server derives it |
| The account exists | 404 `NOT_FOUND` |
| It runs `VAULT_CODE_HASH` as a global contract and `new` has run | 422 `NOT_A_VAULT` |
| `get_status.owner_id` is the caller | 403 `FORBIDDEN` |
| The vault's token answers `ft_metadata` | 422 `TOKEN_UNSUPPORTED` |
| Not registered yet (also a concurrent insert) | 409 `CONFLICT` |
| The caller owns fewer than `MAX_COMPANIES_PER_USER` (5) companies | 409 `COMPANY_LIMIT` |
| The FastNEAR tx API has the vault's first received tx | 503 `VAULT_NOT_INDEXED`, retry in a few seconds |

`deployBlock` is stored as that tx's block minus one and `createdTxHash` as its hash; the vendor is `get_status.vendor_id`. Chain reads share the 60 a minute lookup budget of the vault routes (503 `VAULT_READS_BUSY`); a chain or tx API failure is 502. The indexer, projector and health checks pick the vault up at once.

### Tester onboarding

The tester process derives one key per vault and writes its public key; the API never sees the seed. The owner adds that key to their own account as a function-call key, then opts in.

`GET /public/tester/:shopId` (registered vaults only, 404 otherwise; 30 a minute):

```json
{ "shopId": "selfserve-e2e.ss-owner-e9c3db.testnet", "signerId": "ss-owner-e9c3db.testnet", "publicKey": "ed25519:...",
  "receiverId": "selfserve-e2e.ss-owner-e9c3db.testnet", "methods": ["commit_batch", "prove_delivery", "release", "reveal"],
  "allowanceYocto": "1000000000000000000000000", "minAllowanceYocto": "100000000000000000000000", "enabled": false, "state": "provisioning" }
```

`publicKey` is `null` and `state` `provisioning` until the tester has written the key (at most a minute after registration). `signerId` is the vault's on-chain owner (cached 60 s). `allowanceYocto` is the recommended allowance (`TESTER_ALLOWANCE_YOCTO`, 1 NEAR). Other `state` values come from the tester: `ok`, `key_missing`, `key_scope`, `allowance_unlimited`, `allowance_low`, `owner_changed`, `unarmed`, `no_vendors`, `policy_unsupported`, `low_float`, `over_capacity`, `budget`, `error`.

The owner signs, as owner and receiver of the tx, one `AddKey` with `{ publicKey, accessKey: { permission: { receiverId: shopId, methodNames: methods, allowance: allowanceYocto } } }`. CLI: `near account add-key <owner> grant-function-call-access --allowance '<allowance> yoctonear' --contract-account-id <shopId> --function-names commit_batch,prove_delivery,release,reveal use-manually-provided-public-key <publicKey> network-config testnet sign-with-legacy-keychain send`.

`PUT /company/tester` with `enabled: true` requires, else the listed error:

| Requirement | Refusal |
|:-|:-|
| Not the default vault (its settings live in `.env.tester`) | 409 `DEFAULT_VAULT_ENV` |
| The tester has written the public key | 422 `provisioning` |
| The owner holds exactly that key: a plain function-call key to the vault, exactly the four methods, a finite allowance of at least `TESTER_MIN_ALLOWANCE_YOCTO` (0.1 NEAR) | 422 `key_missing`, `key_scope`, `allowance_unlimited` or `allowance_low` |
| At least one vendor on file | 422 `no_vendors` |
| `policy.batch_size` at most `TESTER_MAX_BATCH_SIZE` (10) | 422 `policy_unsupported` |
| Fewer than `TESTER_MAX_VAULTS` (10) other vaults enabled | 409 `TESTER_FULL` |

`commitCron` must be `M H * * *` (at most hourly; 400 otherwise); `null` means the tester's default. `enabled: false` stops new commits only; sealed tests are still revealed. Enabling records `testerSignerId` and, the first time, `testerEnabledAt` (capacity order).

## Vendor routes (sign-in)

The agent vendor (`/public/config` `vendor`, the vault's on-chain `vendor_id`) signs in with the same NEP-413 flow as the owner: `/auth/verify` issues a session to any account that signs with one of its full-access keys. `X-Shop` selects the vault (default shop4); it must be registered (404 `COMPANY_NOT_FOUND`), malformed is 400. `/vendor/me` and `/vendor/history` read `get_status` live (cached 5 s) and answer 403 `Only the agent vendor` to any other account, the owner included; 502 when NEAR RPC fails. 30 requests a minute per IP.

| Route | Returns |
|:-|:-|
| `GET /vendor/vaults` | `{ items: [{ shopContractId, name }] }`: registered vaults whose recorded vendor is the caller (a hint; the routes below re-check `get_status` live) |
| `GET /vendor/me` | `{ vault, network, vendorId, ownerId, mode, agentKey, pendingKey, pendingKeyProposedAt, pendingKeyMatchesArmed, cooldownEndsAt, armedAt, demotedAt, staleKey, scorecard, limits, fairness, fairnessWarnings, acceptKey }`, see below |
| `GET /vendor/history?limit&before` | `{ items: Activity[], nextBefore }` over `key_proposed`, `agent_armed`, `agent_key_changed`, `agent_demoted`, `agent_frozen`, `declined` and every `test_revealed` |

`/vendor/me` fields:

- `scorecard` has the same shape as `/public/scorecard`. Chain times (`armedAt`, `demotedAt`, the two below) are ns strings.
- `pendingKeyProposedAt`: block time of the indexed `key_proposed` event for `pendingKey` (ms precision, as ns), or `null` with no pending key or before the indexer has it.
- `cooldownEndsAt`: `demoted_at + policy.rearm_cooldown`, or `null` if never demoted. The contract checks it in the owner's `propose_key`, not in `accept_key`: once a key is pending, the cooldown has passed. `accept_key` refuses when `mode` is `Armed`, when the key is not the pending one, or, for a gas key (`limits.key_nonces > 0`), when the vault lacks free NEAR to fund it.
- `limits`: `{ max_per_payment, daily_cap, max_payments_per_day, max_decisions_per_day, max_new_payees_per_day, rearm_cooldown, key_nonces, key_allowance }` from `get_policy` (`key_nonces` 0 is a classic key).
- `pendingKeyMatchesArmed` (NF-06): `null` with no pending key; else `true` only if `pendingKey` is the key of the last successful indexed `agent_armed`. `false` means the owner proposed a key this vault never armed: the vendor should check it is its own agent's key before accepting, because whoever holds the armed key can pay a lure and get the agent demoted.
- `fairness` (NF-06): the policy that keeps the owner from framing the agent, raw from `get_policy`: `{ payee_delay, min_answer, test_ttl, reveal_grace, batch_size, batch_interval, limits_delay, rearm_cooldown }` (ns strings; `batch_size` a number; `min_answer` `null` before contract 2.3.0).
- `fairnessWarnings`: any of `payee_delay_under_1h`, `limits_delay_zero`, `min_answer_at_floor` (`min_answer <= test_ttl / 4`, the lowest the contract allows). The contract accepts these settings; they leave the agent less room.
- `acceptKey`: `null`, or the wallet call that arms the pending key, `{ receiverId, methodName: "accept_key", args: { public_key }, gas: "30000000000000", deposit: "1" }`.

## Activity items

`/vendor/history`, `/company/alerts` and the webhook use one mapper ([`backend/src/lib/alerts/map.ts`](src/lib/alerts/map.ts)), so the same event reads the same everywhere.

```json
{ "id": "cmh...", "kind": "demoted", "at": "2026-11-12T10:05:00.000Z", "text": "Agent demoted on shop4.ss-owner-e9c3db.testnet: it paid lure slot 7. Its key can now only propose payments.", "txHash": "...", "slot": 7, "proposalId": null, "event": "agent_demoted", "blockHeight": "245911204" }
```

`id` is the indexed event id and the `before` cursor; `at` is the block time; `text` is one line of plain text (render it as text). Newest first. A page can hold fewer than `limit` items when an indexed event fails validation; keep following `nextBefore` until `null`.

| `kind` | From | Webhook `type` | `slot` / `proposalId` |
|:-|:-|:-|:-|
| `armed` | `agent_armed` | `agent_armed` | |
| `arming_failed` | `agent_armed` with `ok: false` | `agent_arming_failed` | |
| `demoted` | `agent_demoted` | `agent_demoted` | slot |
| `key_proposed` | `key_proposed` | | |
| `key_changed` | `agent_key_changed` with `ok: true` (text says which methods, or deleted) | | |
| `key_change_failed` | `agent_key_changed` with `ok: false` | | |
| `test_failed` | `test_revealed` `Failed` | `test_failed` | slot |
| `test_passed` | `test_revealed` `Passed` | | slot |
| `test_other` | `test_revealed` `Unanswered`, `Ignored`, `Void`, `Invalid` or `Misdirected` (text says which) | | slot |
| `proposal` | `proposed` | `payment_proposed` | proposalId |
| `declined` | `declined` | `declined` | |
| `frozen` | `agent_frozen` | `vault_frozen` | |
| `reveal_overdue` | health: `get_scorecard.overdue_unrevealed` rose | `reveal_overdue` | |
| `tester_stalled` | health: no release for a delivery tick two ticks old, or no batch within `batch_interval` + 1 h while Armed | `tester_stalled` | |
| `gas_key_overfunded` | health: an agent gas key holds more than `key_allowance` + 10% | `gas_key_overfunded` | |

`/company/alerts` lists the kinds that have a webhook `type`. Items also carry `event` (the contract event name) and `blockHeight` (string).

Health items are derived, not indexed: `id` is `health:<kind>:<ms>`, `at` is when the condition last changed, `event` is `health`, `blockHeight` and `txHash` are `null`. The API checks every `ALERT_HEALTH_SECONDS` (default 60) and stores each condition in `ChainCursor` (`health:<vault>:<kind>`). An alert fires on change only: a higher overdue count, a new stall reason, or a key newly overfunded; a cleared condition is stored silently. The webhook body for a health alert has `data: { value }` (overdue count, stall bits 1 release and 2 commit, or the gas key balance in microNEAR). What to do about each: [README, If something is down](../README.md#if-something-is-down).

A `declined` text reads `Agent declined invoice <first 8 chars of the id>: <reason>. Review it; pay manually or approve a proposal if it is genuine.` A declined real invoice needs a human. The reason is model-written, so it is made inert: control, format and line-separator characters become spaces, `@ < > [ ] `` ` `` become look-alikes (`＠ ‹ › ( ) '`), whitespace collapses, and it is cut to 140 UTF-8 bytes (the contract's limit) without splitting a character; `no reason given` when empty. `data.reason` in the webhook carries the same cleaned text. Lures are declined too and look the same, by design.

Proposal texts give the amount in token units (`1.440000 tUSDC`), or in base units when the token metadata read fails. Events whose strings hold anything outside `[A-Za-z0-9._:-]` are dropped, not escaped.

## Alert webhooks

With `ALERT_WEBHOOK_URLS` set, the API POSTs one JSON body per alert (the kinds with a webhook `type` above) to every URL. Slack and Discord incoming webhooks accept it as is (`text`, `content`). The body is the activity item plus context:

```json
{
  "id": "cmh...",
  "type": "agent_demoted",
  "kind": "demoted",
  "at": "2026-11-12T10:05:00.000Z",
  "text": "Agent demoted on shop4.ss-owner-e9c3db.testnet: it paid lure slot 7. Its key can now only propose payments.",
  "txHash": "...",
  "slot": 7,
  "proposalId": null,
  "event": "agent_demoted",
  "blockHeight": "245911204",
  "vault": "shop4.ss-owner-e9c3db.testnet",
  "network": "testnet",
  "data": { "slot_id": 7, "public_key": "ed25519:..." },
  "content": "<same as text>",
  "allowed_mentions": { "parse": [] }
}
```

`id` stays the same across retries, so a receiver can drop duplicates. Up to 3 attempts per URL (timeouts, network errors, 408, 429, 5xx; 1 s then 2 s backoff); redirects are not followed. Before each attempt the host name is resolved, and the attempt is refused (`BlockedAddress`, no retry) if any address is private, loopback, link-local, CGNAT, multicast, IPv4-mapped or -compatible, NAT64 or 6to4. `fetch` resolves again, so this narrows DNS rebinding rather than closing it; URLs on `localhost`, `127.0.0.1` or `[::1]` are not resolved.

Signature (NF-08). Every request carries `X-SecretShopper-Timestamp: <unix seconds>`, fresh on each attempt. With `ALERT_WEBHOOK_SECRET` set it also carries `X-SecretShopper-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`. To verify:

1. Read the raw body bytes before any JSON parsing.
2. Refuse if the timestamp is more than 300 s (5 minutes) from your clock; this stops replays of a captured alert.
3. Compute `sha256=` + hex HMAC-SHA256 with the shared secret over the timestamp, a `.`, and the raw body.
4. Compare with the header in constant time (`crypto.timingSafeEqual`), then parse.

`verifyAlertSignature` in [`backend/src/lib/alerts/webhook.ts`](src/lib/alerts/webhook.ts) does exactly this and is tested in `backend/test/alerts.test.ts`. Delivery is at least once: the event cursor is stored in `ChainCursor` (`alerts:<vault>`), so after an API restart the worker sends what was indexed while it was down. The very first start begins at the newest indexed event and sends no history.

## Self-serve vaults (no sign-in)

Any company with a NEAR wallet can create its own vault from the published global contract (`VAULT_CODE_HASH`, contract 2.3.0 on testnet) and watch it live. The API only reads the chain and returns unsigned transactions; the wallet signs them.

| Route | Returns |
|:-|:-|
| `GET /public/vault-template` | `{ network, codeHash, codePublished, planEnabled, defaultTokenId, defaultPolicy, policyBounds, minFundingYocto, notes }`. `defaultPolicy` is `scripts/fixtures/policy-testnet.json`; `policyBounds` says in words what the plan checks; 502 when NEAR RPC fails |
| `POST /public/vault-plan` | The plan below, or an error (see Plan errors); 502 when NEAR RPC fails |
| `GET /public/vault/:shopId` | Any account whose `view_account` shows `global_contract_hash` equal to `VAULT_CODE_HASH` and that is initialized: `{ vaultId, codeHash, storageUsage, balanceYocto, keys, keySummary, status, scorecard, policy, createdTx, registered }`. `keys` is the RPC `view_access_key_list` items unchanged (`{ public_key, access_key: { nonce, permission } }`, at most 100). `keySummary` is `{ count, fullAccess, nonAgentKeys, truncated, items: [{ publicKey, kind, variant, receiverId?, methodNames? }] }`: the three counts cover every key the RPC returned, `truncated` is true past 100, and `fullAccess` (FullAccess or GasKeyFullAccess) is the number to show, never a count over `keys` (audit NF-03). `status`, `scorecard` and `policy` are the contract views unchanged. `createdTx` is the first tx the account received per the FastNEAR tx API, `null` when unavailable. For a vault made by this plan that is its creation tx; a failed tx someone sent to the name before it existed would show instead, so `scripts/verify-evidence.ts` remains the check of how a vault was created (V21-04, NF-07). `registered` is whether this API has a company for it (`null` if the database lookup failed). 404 `NOT_FOUND` when the account does not exist; 422 `NOT_A_VAULT` with `error.codeHash` (the account's global or classic code hash) when it runs other code or was never initialized, classic deployments such as shop3 included. Cached 5 s in a route-owned cache of 256 ids. 503 `VAULT_READS_BUSY` when the shared budget of 60 uncached lookups a minute (vault views and plans together, all clients) is spent |

Plan request (strict; unknown fields are 400):

```json
{ "ownerId": "acme.testnet", "name": "shop", "vendorId": "agentco.testnet", "tokenId": "tusdc.ss-owner-e9c3db.testnet",
  "policy": { "daily_cap": "9000000" }, "fundNear": "1.5" }
```

| Field | Rule |
|:-|:-|
| `ownerId`, `vendorId` | Existing accounts, different from each other |
| `name` | One account-id part (lowercase letters and digits, single `-` or `_` inside); the vault is `<name>.<ownerId>`, must not exist and must be a valid id (64 characters at most) |
| `tokenId` | Optional, default `VAULT_DEFAULT_TOKEN_ID`; needs `ft_metadata` and `storage_balance_bounds` |
| `policy` | Optional partial override of `defaultPolicy`, same field names and types as the contract `Policy`; the merge must pass `checkPolicy` and `storage_deposit` must be at least the token's `storage_balance_bounds.min` |
| `fundNear` | Decimal NEAR, at least `minFundingYocto` for the merged policy (0.8606 NEAR for the default); the owner must be able to spend it plus the storage deposit and about 0.05 NEAR in fees |

Plan errors use the standard envelope with extra keys inside `error`. `fields` is `[{ field, message }]` with `field` one of `ownerId`, `name`, `vendorId`, `tokenId`, `fundNear` or `policy.<key>` (an unknown key gives its own path):

| Status | `error.code` | When | Extra keys |
|:-|:-|:-|:-|
| 400 | `VALIDATION_ERROR` | Malformed body (`message` is `Invalid input: <fields>`), or every refusal belongs to a field: owner and vendor equal, owner or vendor missing, token without `ft_metadata` or NEP-145, policy out of bounds, funding below the minimum or above what the owner can spend (`message` is the reasons joined by `; `) | `fields` |
| 409 | `VAULT_EXISTS` | `<name>.<ownerId>` already exists (other problems are listed too) | `vaultId`, `fields` |
| 422 | `VAULT_PLAN_REFUSED` | A refusal without a field, such as the code hash not being published; `message` joins every reason | `fields` (the field ones) |
| 403 | `VAULT_PLAN_DISABLED` | Mainnet without `VAULT_PLAN_MAINNET=true` | |
| 503 | `VAULT_READS_BUSY` | The shared budget of 60 chain lookups a minute is spent | |

These 4xx and 503 answers are logged to stdout only, never to the error log table, so a flood cannot rotate real errors out (NF-04).

Policy rules beyond `checkPolicy`: `payee_delay` must be at least 1 hour (`policy.payee_delay` field error), so the owner cannot delist a payee and frame the agent in one block. `defaultPolicy` caps are 6-decimal units (tUSDC); a plan scales every cap the request leaves out to the token, `cap * 10^(decimals - 6)`, exactly, and refuses with 422 when that is not an integer within u128 (audit NF-02). Caps given in the request are taken as token base units and earn a warning when the token does not have 6 decimals.

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "owner and vendor must differ",
  "fields": [{ "field": "vendorId", "message": "owner and vendor must differ" }] }, "data": null, "timestamp": "..." }
```

Plan response `data`: `{ network, signerId, vaultId, codeHash, token: { id, symbol, decimals }, caps: { dailyCap, maxPerPayment, scaled }, fundYocto, minFundingYocto, storageDepositYocto, totalYocto, init, transactions, cli, next, warnings }`. `signerId` is `ownerId` (each transaction also carries it); `totalYocto` is every deposit in both transactions. `caps` repeats the two caps in `init.policy` in token base units; `scaled` lists the ones taken from the default and scaled to the token. `transactions` goes to NEAR Connect `signAndSendTransactions({ transactions })` in order (amounts and gas are decimal strings):

```json
[
  { "signerId": "acme.testnet", "receiverId": "shop.acme.testnet", "actions": [
      { "type": "CreateAccount" },
      { "type": "Transfer", "params": { "deposit": "1500000000000000000000000" } },
      { "type": "UseGlobalContract", "params": { "contractIdentifier": { "codeHash": "5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs" } } },
      { "type": "FunctionCall", "params": { "methodName": "new", "args": { "owner_id": "acme.testnet", "vendor_id": "agentco.testnet",
          "token_id": "tusdc.ss-owner-e9c3db.testnet", "intents_id": null, "policy": { "...": "merged policy" } }, "gas": "50000000000000", "deposit": "0" } } ] },
  { "signerId": "acme.testnet", "receiverId": "tusdc.ss-owner-e9c3db.testnet", "actions": [
      { "type": "FunctionCall", "params": { "methodName": "storage_deposit", "args": { "account_id": "shop.acme.testnet", "registration_only": true },
          "gas": "30000000000000", "deposit": "1250000000000000000000" } } ] }
]
```

The first transaction is atomic: if `new` fails, the account is not created and the transfer returns, less gas. `new` accepts the call because its predecessor is the vault's parent and signed the transaction itself (V21-03), so the vault never holds an access key. `cli` holds the same two transactions as `near` CLI 0.30 commands (`sign-with-legacy-keychain`), `next` the steps after creation (payees, `propose_key`, vendor `accept_key`, resending the token registration alone with `cli[1]` if it did not land, token funding, your own tester and agent), `warnings` for example a token whose decimals do not match the default caps.

## Signed in the wallet, not through the API

The API only reads the chain. Owner and vendor actions are contract calls the web app sends through the wallet, with 1 yoctoNEAR attached and about 30 Tgas (15 Tgas or more for `accept_key` and `freeze`):

| Who | Method | Args |
|:-|:-|:-|
| Owner | `approve`, `reject` | `{ proposal_id }` |
| Owner | `add_payee`, `remove_payee` | `{ account_id, label }`, `{ account_id }` |
| Owner | `propose_key` | `{ public_key }` |
| Vendor | `accept_key` | `{ public_key }`; arms the agent, 30 Tgas (live `7JkEMjHL` used 30 Tgas with a 4-lane gas key) |
| Owner or vendor | `freeze` | `{}` |
| Owner | `set_limits`, `apply_limits`, `withdraw`, `withdraw_near` | see `contracts/shop/src/lib.rs` |
| Anyone | `resync_key` | `{}`, no deposit |

Views for the web app: `get_status`, `get_policy`, `get_scorecard`, `get_payees`, `get_payee_status`, `get_payments`, `get_proposals`, `get_tests`, `get_batches`, `get_decision`, `get_release`.

## Agent-only routes

`GET /inbox/next?afterAt&afterId` and `GET /inbox/vendors/:id` need the agent's inbox token (`Authorization: Bearer`). The env token (sha256 in `INBOX_TOKEN_HASH`, compared in constant time) serves the default vault, as before; a token from `POST /company/inbox-token` serves its own vault only: its invoices, its vendors (another vault's vendor id is 404). An unknown or rotated token is 401. `GET /inbox/whoami` returns `{ shop }`, the vault the token serves; the agent refuses to start when it differs from `AGENT_VAULT_ID`. Real and test items serialize identically (`backend/test/inbox.route.test.ts`). The web app never calls them. `POST /inbox/blocklist` (see Shared payee blocklist) records evidence for the token's vault. `GET /inbox/blocklist/:accountId` has the public lookup's shape but counts only entries whose `vault` is the token's own vault or in `BLOCKLIST_TRUSTED_VAULTS` (default the default vault), so an attacker who owns a vault and its agent cannot block a payee for everyone else (multi-vault design); the agent's preflight blocks a listed payee (`blocklisted`).
