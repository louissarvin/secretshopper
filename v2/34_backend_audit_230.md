# 34. Backend audit for contract 2.3.0: delivery proof, public reads, quote proxy, generator

Date: 2026-11-10. Auditor: security-auditor agent. Follows [v2/21](21_security_audit.md) (SS-B01 to SS-B07, all fixed) and the contract audit [v2/33](33_audit_230.md).

## 0. Scope, method, status legend

| Item | Detail |
|:-|:-|
| Delivery proof | `backend/src/lib/releases.ts`, `backend/src/lib/proof/merkle.ts`, `backend/src/tester/workers.ts` (`postReleases`, `deliveryFor`, `proveIfDelivered`, `proveDeliveries`, `revealWatcher`, `commitBatchWith`, `finalize`), `backend/src/tester/chain.ts` (`releaseTx`, `proveDeliveryTx`), `backend/src/tester/recovery.ts`, `backend/src/utils/delivery.ts`; checked against `release`, `ack`, `prove_delivery`, `check_delivery` and `reveal` in `contracts/shop/src/lib.rs` |
| Public reads | `backend/src/routes/publicRoutes.ts`: `GET /public/quote`, `/public/releases/:shopId`, `/public/evidence/:shopId`, `/public/ledger/:shopId`, `/public/tests/*` |
| Projection and outputs | `backend/src/lib/near/applyEvent.ts` (`release_posted`, `release_acked`, Ignored upgrade), `backend/src/lib/ledger.ts`, `backend/src/lib/evidence.ts` |
| Generator | `backend/src/tester/generator.ts`, `nearai.ts`, `receipt.ts` |
| Float and startup | `backend/src/lib/near/shop.ts` `floatHeadroom`, `backend/tester.ts` |
| Consumers checked | `agent/src/acks.ts` (tick collection and ack), `backend/src/routes/inboxRoutes.ts`, `invoiceRoutes.ts`, `scripts/verify-evidence.ts` |
| Stack | Fastify 5.6 with @fastify/rate-limit 11.2.1 (not Hono), Prisma 7, zod 4.6.7, Bun 1.4.4 |
| References | [OWASP WSTG business logic](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/README), [OWASP API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/), [OWASP CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection), [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), [@fastify/rate-limit route config](https://github.com/fastify/fastify-rate-limit) |

Threat model (from the brief). The company owner runs the tester and the API. The vendor and the agent operator are counterparties. The public reads `/public/*`.

Status legend:
- **CONFIRMED**: a test failed on the unfixed code and passes after the fix. All of them are in `backend/test/audit230.regression.test.ts`.
- **PLAUSIBLE**: follows from the code path. Not exercised at runtime.

No High finding. Nothing found lets the API role or the agent read a lure's preimage or linkage before reveal. No backend path lets the owner score an honest agent `Ignored` or `Failed`, because the contract checks every delivery condition itself. The 1Click proxy has no caller-controlled URL and never echoes the partner key.

## 1. Findings table

| ID | Severity | Component | File:line (before fix) | Description | Status | Fixed |
|:-|:-|:-|:-|:-|:-|:-|
| B23-01 | Medium | Public evidence | `src/routes/publicRoutes.ts:241-290` | `GET /public/evidence/:shopId` rebuilds the whole bundle on every request: no route limit (global 120/min), no cache, no paging, up to 1000 slots with full receipts, read in no fixed order | CONFIRMED | Yes |
| B23-02 | Low | Release ticks | `src/utils/delivery.ts:16, 36`; `src/tester/workers.ts:116-123` | An invoice's tick can be milliseconds after the insert starts. A row committed after its tick is skipped for good by an agent whose cursor has passed it, and the agent's ack then mismatches the release root | CONFIRMED | Yes |
| B23-03 | Low | Lure placement | `src/utils/delivery.ts:31-38`; `src/tester/workers.ts:116, 208` | Test ticks ignore `min_answer`. With `min_answer > test_ttl / 2`, lures land where an ignored lure can never be proven delivered, so it stays `Unanswered` and unscored | CONFIRMED | Yes |
| B23-04 | Low | Quote proxy | `src/lib/intents/quote.ts:197, 208`; `publicRoutes.ts:201-211` | Any caller spends the operator's 1Click partner key for any payee and recipient, and every quote fetches the full token list again | PLAUSIBLE | Yes |
| B23-05 | Info | Release posting | `src/tester/workers.ts:329-334` | A tick already on chain is marked posted even when its root or count differs from the database. The mismatch shows only at reveal time | CONFIRMED (source check) | Yes |
| B23-06 | Info | Tester startup | `tester.ts:38-42` | The headroom warning counts open slots from the database, not the chain's `open_slots`, and leaves out the 2,000-byte flush margin | CONFIRMED (unit test) | Yes |
| B23-07 | Info | Lure timing | `src/tester/workers.ts:97-103` | `realReleaseHistory` drops only tests sealed in the last `REAL_HISTORY_DAYS + 3` days. With `test_ttl` above 3 days, older lures count as real releases, so test hours feed their own weights | CONFIRMED (source check) | Yes |
| B23-08 | Info | Public releases | `src/routes/publicRoutes.ts:215-238`; `src/lib/releases.ts:26-30` | The route publishes the company's invoice count per tick, and a tick's id list has no cap. This is by design in v2/32 and the agent sees the same items, but the public learns accounts-payable volume | PLAUSIBLE | No |
| B23-09 | Info | Tester concurrency | `src/tester/workers.ts:160-178, 194-300` | A cron `recoverPrepared` can finalize a batch while `commitBatch` waits for its tx. The second `finalize` rolls back on the unique invoice id, so nothing is delivered twice. If recovery wins, though, `testBatch.signerId` stays null and the commit logs `run failed` | CONFIRMED (unit test) | Yes |
| B23-10 | Info | Projector | `src/lib/near/applyEvent.ts:134-138` | An `Ignored` event for a slot whose first reveal was never projected (an indexer gap, SS-B09) records the `prove_delivery` tx as the reveal tx | CONFIRMED (unit test) | Yes |
| B23-11 | Info | Generator | `src/tester/generator.ts:102, 264` | `TEST_DOMAIN_SUFFIX` is read from `process.env` outside the tester config. Setting it to an empty string silently turns the foreign-domain check off | PLAUSIBLE | Yes |

Count: 0 High, 1 Medium, 3 Low, 7 Info. Fixed: every finding except B23-08, which is by design.

## 2. Findings

### B23-01 [Medium] Public evidence bundle is unbounded

**Vulnerability.** Every `GET /public/evidence/:shopId` made five database reads and serialized every revealed lure's invoice and AI receipt, with no cache. Only the global limit of 120 requests a minute per IP applied (`app.ts:28`). The slot read was `take: 1000` with no `orderBy`, so past 1000 slots the bundle silently dropped arbitrary slots.

**Size.** A stored generation receipt without its attestation is about 16 KB, mostly `responseBody`. That was measured on `scripts/out/b1-generate-receipts.json`.

| Revealed lures | Bundle size | Per IP per minute at 120 req |
|:-|:-|:-|
| 300 | about 5 MB | about 600 MB out, 600 full table reads |

**Reproduction (CONFIRMED).** Send 12, later 22, requests from one client through `app.inject`. Before the fix none returned 429.
```
bun test test/audit230.regression.test.ts -t "B23-01"
```

**Impact.** API4:2023 unrestricted resource consumption. One client can tie up the database pool and bandwidth on a public route that needs no auth. That also starves the agent's `/inbox` calls, which share the pool. Verifiers lose slots past 1000 at random.

**Fix (applied).**
- A route limit of 20 per minute (`evidenceLimit`).
- Pages of 100 slots in slot order, selected by a `fromSlot` query that must be a multiple of 100. So there is at most one cache key per page, and the cache is capped at 500 entries.
- A 30 s cache per page.
- `next_from_slot` in the bundle points to the next non-empty page.
- Receipts are filtered by `companyId` as defense in depth.
- `scripts/verify-evidence.ts` follows `next_from_slot` and waits on a 429.

```ts
// BEFORE
app.get('/evidence/:shopId', async (request, reply) => { /* 5 reads, take: 1000, no order, no cache */ });
// AFTER
app.get('/evidence/:shopId', { config: evidenceLimit }, async (request, reply) => {
  /* fromSlot % 100 === 0 */
  const bundle = await cached(`evidence:${shopId}:${fromSlot}`, EVIDENCE_TTL_MS, () => evidencePage(company.id, shopId, fromSlot));
});
```

**Reference.** [OWASP API4:2023](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/), [@fastify/rate-limit route config](https://github.com/fastify/fastify-rate-limit).

### B23-02 [Low] An invoice row can appear after its own tick

**Vulnerability.** Both helpers rounded up from `now`, so a tick could be 1 ms after the insert began:
- `nextRealDelivery(now)` returned the first tick strictly after `now`.
- `candidateTicks` did the same for tests.

`finalize` also took `now` before its slow read of the release history. The agent's inbox cursor (`afterAt`, `afterId`) only moves forward (`agent/src/acks.ts:52-70`, `inboxRoutes.ts:31-33`). So a row committed after the agent has read past its tick at a higher id is never served.

**Reproduction (CONFIRMED).** Enter an invoice at `12:00:00.000 - 1 ms` with 120-minute ticks:

| | Release time |
|:-|:-|
| Before | `12:00:00.000`, 1 ms after the insert started |
| After | `14:00` |

A test commit at `11:59:30` got a tick 30 s later before the fix.

**Impact.**
- A real invoice can be skipped forever by the agent, so a supplier goes unpaid.
- The agent's ack root lacks the late row, so the on-chain record shows a mismatched ack. That looks like a forked inbox and blames an honest owner.
- Every lure in that tick loses its delivery proof.

The window is milliseconds against a 2-hour tick, so it is rare.

**Fix (applied).**
- `TICK_LEAD_MS = 60 s`: both helpers round up from `now + TICK_LEAD_MS`.
- `finalize` reads the history first and takes `now` right before the insert.

**Reference.** [WSTG-BUSL-04 process timing](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/04-Test_for_Process_Timing).

### B23-03 [Low] Lures placed after the last provable tick

**Vulnerability.** The contract scores `Ignored` only if `release_at <= expires_at - min_answer` (`check_delivery`). The tester places lures anywhere in the first half of the remaining lifetime and never reads `min_answer`. `create-vault.ts` accepts any `min_answer` in `[test_ttl / 4, test_ttl)`.

**Reproduction (CONFIRMED).** `test_ttl = 48 h`, `min_answer = 40 h`, commit at `00:00:05`. Before the fix, lures landed up to `12:00`, which is 12 h past the provable deadline of `08:00:05`.

**Impact.** An agent that ignores those lures gets `Unanswered`, which is unscored, instead of `Ignored`. That reopens the lazy-agent gap that v2/32 closes. It only happens under a `min_answer` above half the `test_ttl`. A late crash recovery makes it more likely.

**Fix (applied).**
- `candidateTicks` and `testDeliveryTimes` take an `answerBy` cap.
- `finalize` passes `expires_at - min_answer`.
- `commitBatch` refuses to commit when no tick fits.

### B23-04 [Low] The quote proxy spends the partner key for anyone (fixed)

**Vulnerability.** `GET /public/quote` is public and accepts any `payee`, `destinationAsset` and `recipient`. Every call makes two 1Click requests (`listTokens` is not cached), and when `ONECLICK_JWT` is set it authenticates as the operator. The limit is 10 per minute per IP.

**Reproduction (PLAUSIBLE).** N clients with distinct IPs send 10 quotes a minute each. That makes 20N partner-authenticated 1Click calls a minute, none tied to a vault payee.

**Impact.** The partner key's quota and reputation are spent by strangers, and the operator's fee schedule is exposed for arbitrary routes. No SSRF: the base URL comes from config only and must be https (`checkUrl`). No key leak: the key goes only in `X-API-Key` and is never echoed.

**Fix (recommended).**
- Cache `/v0/tokens` for 5 minutes.
- Send the JWT only when `payee` is an approved payee of a registered vault, else quote unauthenticated.
- Add a global per-key budget, not only a per-IP one.

Applied after the Intents agent finished: `GET /v0/tokens` is cached for 5 minutes through a `tokens` loader dependency of `dryQuote`; the route sends `ONECLICK_JWT` only when `payee` is an active approved payee of `SHOP_CONTRACT_ID` (`get_payee_status`, cached 60 s; a failed read quotes without the key) and only while a global sliding budget of 60 partner quotes a minute has room (`createBudget`). The response `feeNote` says which fee schedule applied. Regression: `test/intents.quote.test.ts` "B23-04".

### Info items

- **B23-05 (fixed).** `postReleases` now compares the on-chain root and count with the recomputed tick and logs `posted release differs from the tick in the database`. Before, the first sign was a warning at reveal time, hours later.
- **B23-06 (fixed).** The startup warning now uses `writeHeadroom` (`src/lib/near/shop.ts`). That is `floatHeadroom` minus the contract's 2,000-byte `FLUSH_MARGIN_BYTES`, so it reaches 0 exactly where `assert_float` starts refusing. It still counts `Committed` rows in the database, because no view exposes `open_slots`. A comment in `tester.ts` says so.
- **B23-07 (fixed).** `realReleaseHistory` now excludes every sealed slot with `expiresAt >= since`. `expiresAt` is the chain's `expires_at`, which is commit time plus the vault's own `test_ttl`. A test released after `since` was delivered before its expiry, so it is always in that set, whatever the `test_ttl`. The fixed 3-day window is gone.
- **B23-08.** The `/public/releases` volume exposure is inherent to letting anyone recompute the root. If accounts-payable volume is sensitive, publish only the root and count and give the ids to the agent and to verifiers holding a key. A tick's id list is bounded only by real volume. Cap ids per tick in the response and page within a tick if volume grows.
- **B23-09 (fixed).** The transactional half of `finalize` moved to `src/tester/finalize.ts` (`finalizeInTx`). It claims each row with `updateMany({ where: { id, status: 'Prepared' } })` before inserting anything. Under Postgres Read Committed, a concurrent claim waits for the row lock, re-checks the WHERE clause, and matches nothing ([PostgreSQL 13.2.1](https://www.postgresql.org/docs/17/transaction-iso.html)). So the second finalize inserts no invoice and raises no unique-key error, but still upserts `testBatch` with the commit tx and signer. Recovery logs the number of slots it actually claimed.
- **B23-10 (fixed).** For an `Ignored` event on a slot with no projected reveal, the projector reads `get_test` and passes the chain's `reveal.at` to `revealFields` (`src/lib/near/revealFields.ts`). The event tx counts as the reveal tx only when its block time equals the reveal time, which is the `reveal(.., delivery)` case. A later `prove_delivery` event leaves `revealTxHash` null and keeps the chain reveal time.
- **B23-11.** Fixed: the generator keeps reading `TEST_DOMAIN_SUFFIX` itself (the scripts import it without the tester's secrets) but lowercases it and refuses anything that is not a dotted suffix, so the foreign-domain check cannot be switched off.

## 3. Checked and sound

| Area | What holds |
|:-|:-|
| Merkle tree (`merkle.ts`) | Leaf `0x00`, node `0x01`, zero padding to a power of two, depth `ceil(log2(max(count,1)))`. `sortedIds` refuses empty sets, non-32-byte ids and duplicates. `verifyMerkle` bounds `index < count` and `proof.length == depth`. The same fixed vectors are shared with the Rust and agent trees |
| `deliveryFor` vs `check_delivery` | Same rules in the same order: no decision ever (V23-04), mode Armed or Demoted, release exists and ack root equals release root, `committed_at <= release_at <= expires_at - min_answer`, `ack.at <= deadline`, ack key equals `agent_key`, `armed_at <= ack.at`, no freeze in `(ack.at, deadline]`, local proof verifies against the chain root and count. A refused proof falls back to a plain reveal, so no slot is left overdue |
| Owner framing through the backend | `Ignored` needs the agent's own `ack` over a root it computed from items it received. The contract refuses future `release_at`, out-of-window ticks, other keys, earlier armings and freezes. Backend timing or data can only lose a proof, never create one |
| Release posting | One release per tick: `getRelease` first, and the contract refuses duplicates. `release_at <= min(local, chain final time) - 60 s`. A crash after the tx lands is caught by `getRelease` on the next run |
| `GET /public/releases` | Closed ticks only (`now - RELEASE_SETTLE_MS`), and the ids were already served to the agent. No tester import, no linkage. `since` and `limit` are validated, 30 a minute |
| Lure secrecy (SS-B04 class) | No new API-side file touches `SealedSlot` or `GenerationAttempt` (the separation and SS-B04 tests pass). AI receipts reach `ai_receipts` only in `publish` after reveal. The generation log is published only when the whole run is revealed. `proveIfDelivered` writes only after reveal |
| Quote proxy SSRF and secrets | No caller-controlled host, path or header. Input is validated before any request. Upstream failures map to a generic 502 (`handleUpstreamError`). The 1Click 400 message is cut to 200 printable ASCII characters in a JSON body (`nosniff`). The echoed request must equal the request sent |
| Ledger CSV | Leading `= + - @ TAB CR` get a `'` prefix as in OWASP CSV Injection, with RFC 4180 quoting. Amounts are exact u128 or the request fails. At most 20,000 events, 10 a minute. A second `test_revealed` for a slot upgrades the row in place |
| Evidence JSON | Unrevealed slots carry only index and status. Invoices and receipts appear only for revealed slots. Gateway receipts are labelled `partial` |
| Projector | Every event is zod-checked. The `Ignored` upgrade changes only `status`. Writes to `tests` use `updateMany` under the column grants |
| Generator and NEAR AI | Drafts go through the real intake normaliser (SS-B03). Telltale wording, foreign domains, dates, arithmetic, amount band, payee placement and sender domain are all checked. Strict TCB (`UpToDate`) on gateway and model. A receipt is bound to its attestation before it is used. The API key is only in the SDK's auth header, never in `requestBody` |
| Crash paths | Rows are persisted as `Prepared` before the tx. Recovery runs at start and every 10 minutes and abandons only after the tx validity window. The tlock re-seal keeps commitments. `publish` is idempotent. `proveDeliveries` catches reveals made by others while the tester was down |
| `floatHeadroom` | Same formula as the contract's `reserve()`: storage, plus the larger of the float and `open_slots * 600 B`, plus `key_allowance` for an armed gas key |

## 4. Proof of concept results

All in `backend/test/audit230.regression.test.ts`. Before the fix, a copy with the new constant defined locally failed all 8 then-existing tests. Those 8 cover B23-01, B23-02 and B23-03. The paging unit test and the B23-05 source check were added with the fixes. B23-06, B23-07, B23-09 and B23-10 got unit tests or source checks on 2026-11-11. The B23-09 test drives `finalizeInTx` twice against a fake transaction with Postgres claim semantics. A real two-connection race would need `TEST_DATABASE_URL`.

| Test | Before fix | After fix |
|:-|:-|:-|
| B23-01 one IP and 22 evidence requests | no 429 | 429 from the 21st request |
| B23-01 `fromSlot=7`, `fromSlot=-100` | 500 (query ignored) | 400 |
| B23-02 invoice entered 1 ms before a tick | released 1 ms later | next tick, at least 60 s later |
| B23-02 test commit at 11:59:30 | tick 30 s later | tick at least 60 s later |
| B23-03 `min_answer` 40 h of 48 h | lures up to 12 h past the deadline | none past `expires_at - min_answer` |
| B23-06 balance = storage + float + 2,000 B | warning headroom 0.02 NEAR | `writeHeadroom` 0, the point where `assert_float` starts refusing |
| B23-09 second finalize of a batch | unique-key rollback, `run failed`, signer lost if recovery won | claims 0 rows, no insert, signer recorded |
| B23-10 Ignored event 10 min after the reveal block | `prove_delivery` tx stored as the reveal tx | reveal tx null, chain reveal time kept |

Final run, from `backend/`:
```
bun test
 172 pass
 11 skip
 0 fail
Ran 183 tests across 20 files.
bun run typecheck   (clean)
bun run lint        (eslint, clean)
scripts: bun run typecheck (clean)
```
The 11 skips are the Postgres and network tests listed in AGENTS.md. `bun run demo` was not rerun. It calls `buildEvidence`, whose new output field defaults to `null`, and the scripts typecheck passes.

## 5. Priority

1. B23-01 is fixed. Deploy it with the updated `scripts/verify-evidence.ts`, since a bundle is now one page unless the verifier follows `next_from_slot`.
2. B23-04 is fixed (by the lead). The partner key now goes only to vault payees, within a global budget.
3. B23-02 and B23-03 are fixed. Choosing `min_answer <= test_ttl / 2` in `create-vault.ts` defaults keeps every lure provable without relying on the cap.
4. Every Info item except B23-08, which is by design, is fixed.

Files changed by this audit:
- `backend/src/routes/publicRoutes.ts`
- `backend/src/lib/evidence.ts`
- `backend/src/utils/delivery.ts`
- `backend/src/tester/workers.ts`
- `scripts/verify-evidence.ts`
- `backend/test/audit230.regression.test.ts` (new)
- `backend/src/tester/finalize.ts` (new, B23-09)
- `backend/src/lib/near/revealFields.ts` (new, B23-10)
- `backend/src/lib/near/applyEvent.ts` (B23-10)
- `backend/src/lib/near/shop.ts` (B23-06)
- `backend/tester.ts` (B23-06)
