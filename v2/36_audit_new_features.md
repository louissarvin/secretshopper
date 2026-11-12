# 36. Audit of the 2026-11-12 features: self-serve vaults, vendor console, alerts, MCP server

Date: 2026-11-12. Auditor: security-auditor agent. Read-only review, no code changed. Follows [v2/34](34_backend_audit_230.md) (B23-01 to B23-11) and [v2/35](35_agent_audit.md) (AG-01 to AG-10).

## 0. Scope, method, status legend

| Item | Detail |
|:-|:-|
| Self-serve vaults (public, no auth) | `backend/src/routes/vaultRoutes.ts`, `backend/src/lib/vault/{policy,plan,view}.ts`, `backend/src/lib/near/vaultChain.ts`, `backend/src/lib/near/events.ts` (`firstIncomingTxHash`), `backend/src/utils/errorHandler.ts` (`details`) |
| Vendor console and alerts | `backend/src/routes/vendorConsoleRoutes.ts`, `backend/src/lib/vendorView.ts`, `backend/src/routes/companyRoutes.ts` (`/company/alerts`), `backend/src/lib/alerts/{map,webhook,token}.ts`, `backend/src/workers/alertWorker.ts`, `backend/index.ts`, `backend/src/config/main-config.ts` |
| MCP server | `agent/mcp.ts`, `agent/src/mcp/{config,server,session}.ts`, `agent/src/env.ts`, `agent/src/inboxClient.ts` |
| Consumers checked | `web/src/routes/new.tsx`, `web/src/routes/vendor.tsx`, `agent/src/tools.ts`, `agent/index.ts`, `scripts/verify-evidence.ts`, `contracts/shop/src/lib.rs` (`accept_key`, policy fields) |
| Tools run | `bun test` in `backend/` (219 pass, 24 skip, 0 fail, 243 tests in 24 files) and `agent/` (75 pass, 0 fail, 9 files); near-cli-rs 0.30.1 help-output walk of the plan's `cli[0]` grammar (nothing signed); two scratch PoCs against `buildVaultPlan` and `readVault` with stub chains |
| References | [OWASP API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/), [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), [OWASP OS Command Injection Defense](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html), [Claude Code MCP output limits](https://code.claude.com/docs/en/mcp), `reference/near-docs/smart-contracts/global-contracts.md` |

Threat model. The public calls `/public/vault-*` with any input. The vendor and the agent operator are counterparties of the owner. The owner runs the tester and the API and may try to frame the agent (as in v2/35). An external MCP model is untrusted and may be prompt-injected by invoice content.

Status legend:
- **CONFIRMED**: reproduced by a test or a scratch PoC on the current code.
- **PLAUSIBLE**: follows from the code path. Not exercised at runtime.

No High finding. The plan's CLI strings are not injectable: every interpolated value is a validated account id, the configured base58 hash, a bigint or single-quoted JSON of validated fields. No public route reaches a caller-controlled URL. The MCP server keeps the native preflight, mode gating, the 3-sign cap and the invoice binding; an external model cannot sign `ack` or act on another invoice.

## 1. Findings table

| ID | Severity | Component | File:line | Description | Status |
|:-|:-|:-|:-|:-|:-|
| NF-01 | Medium | MCP give-up | `agent/src/mcp/session.ts:104-118`, `agent/src/inboxClient.ts:107-112` | Every give-up (timeout or tool-call limit) puts the invoice in the ack. The server cannot tell a model that ignored a lure from a client that could not read it, so an owner can serve an oversized lure and score it `Ignored` (the AG-03 pattern, back through MCP) | CONFIRMED (ack on give-up), PLAUSIBLE (trigger) |
| NF-02 | Medium | Vault plan | `backend/src/lib/vault/plan.ts:268-271`, `policy.ts:38-56`; `web/src/routes/new.tsx:223,280` | Default `daily_cap` and `max_per_payment` are 6-decimal base units for any token. A token with fewer decimals gets caps 10^(6-d) times larger, with only a warning, and the web form has no way to set them | CONFIRMED (PoC) |
| NF-03 | Low | Vault view | `backend/src/lib/vault/view.ts:6,52-60`; `web/src/routes/new.tsx:146-152` | Keys past the first 20 are dropped and no full-access count is returned. The web counts full-access keys from the cut list, so a vault with a full-access key sorted 21st shows "full-access keys 0" | CONFIRMED (PoC), PLAUSIBLE (key order) |
| NF-04 | Low | Public reads | `backend/src/utils/ttlCache.ts:3,8`; `vaultRoutes.ts:42-54,102,110` | `GET /public/vault/:shopId` is the first public route that caches attacker-chosen keys. 500 distinct ids clear the process-wide cache, evicting the evidence and 1Click caches (B23-01, B23-04). Each miss also fans out to RPC and FastNEAR with no global budget | CONFIRMED (source) |
| NF-05 | Low | MCP concurrency | `agent/src/mcp/config.ts:10-13,28-39`; `agent/src/inboxClient.ts:69-74` | Nothing stops two MCP servers on one `MCP_STATE_PATH` (two Claude Code sessions do this by default). The native-agent check uses a cwd-relative path and an mtime window | CONFIRMED (source) |
| NF-06 | Low | Vendor console | `backend/src/lib/vendorView.ts:20-46`; `web/src/routes/vendor.tsx:76-78` | The vendor is handed `accept_key` for whatever key the owner proposed and is told to "accept the same key". It is never asked to match it against its own agent key, and the console omits the anti-framing fields (`payee_delay`, `min_answer`, `test_ttl`) that the plan lets an owner set to 0 or the minimum | PLAUSIBLE |
| NF-07 | Info | Vault view | `backend/src/lib/near/events.ts:106-109`; `vaultRoutes.ts:42-54` | `createdTx` is the first tx the account received, not the creation tx. A failed tx sent to the name before it existed is shown as "created" and cached for the life of the process | PLAUSIBLE |
| NF-08 | Info | Webhook | `backend/src/lib/alerts/webhook.ts:16-40,69,91` | The HMAC covers the body only, with no timestamp, so a captured alert replays forever. The host check is literal only (a DNS name that resolves to a private address passes). The URL comes from operator config, so this is not a public SSRF | CONFIRMED (source) |
| NF-09 | Info | MCP stdout | `agent/mcp.ts:13-14` | Only `console.log` is redirected. In Bun, `console.info`, `console.debug` and `console.table` still write to stdout and would corrupt JSON-RPC. No current dependency on the server path calls them | CONFIRMED (source) |
| NF-10 | Info | MCP config | `agent/src/env.ts:47`; `agent/src/mcp/session.ts:124` | `TOKEN_DECIMALS` comes from env, not from the token's `ft_metadata`. A wrong value scales every `amount_usdc` and every limit shown to the external model. This is the same as the native agent | PLAUSIBLE |
| NF-11 | Info | Docs drift | `backend/src/lib/vault/plan.ts:160`; `vendorView.ts:7`; `AGENTS.md` | The plan's next steps say `accept_key` with 100 Tgas, `acceptKey` sends 30 Tgas and AGENTS.md says about 15 Tgas. AGENTS.md test counts (179 and 56) are behind the suites (219 and 75) | CONFIRMED |

Count: 0 High, 2 Medium, 4 Low, 5 Info.

## 1a. Fix status (2026-11-12, same day)

Every finding was fixed or documented before the API restart at about 14:20 UTC, each with regression tests. Backend 234 pass, 24 skip, 0 fail (250 pass with every gate open); agent 87 pass, 0 fail.

| ID | Status | Fix |
|:-|:-|:-|
| NF-01 | Fixed | `next_invoice` results over `MCP_MAX_RESULT_BYTES` (default 45000, inline in Claude Code) are never served and given up without an ack; a timeout or tool-call give-up is acked only if the agent called `get_vendor`, `check_account`, `pay`, `propose` or `decline` on that invoice (`agent/test/mcp.test.ts`) |
| NF-02 | Fixed | Default caps are scaled to the token's decimals, exactly or refused; `plan.caps` shows the values used; the web form can set both caps (`backend/test/vault.plan.test.ts`) |
| NF-03 | Fixed | `keys` holds up to 100 raw items; `keySummary.fullAccess`, `nonAgentKeys` and `truncated` are counted over the full RPC list; the web reads `fullAccess` |
| NF-04 | Fixed | Own 256-entry LRU per route, a global budget of 60 uncached reads a minute (503 `VAULT_READS_BUSY`), no `ErrorLog` rows for expected 4xx |
| NF-05 | Fixed | Exclusive pid lock next to `MCP_STATE_PATH`; relative state paths resolve against `agent/` |
| NF-06 | Fixed | `/vendor/me` adds `fairness`, `fairnessWarnings` and `pendingKeyMatchesArmed`; the web requires the vendor to confirm the key and shows the terms; plans refuse `payee_delay` under 1 h |
| NF-07 | Documented | `createdTx` is the first tx the account received; for a vault made by the plan that is the creation tx. `verify-evidence` stays the provenance check |
| NF-08 | Fixed | `X-SecretShopper-Timestamp` and HMAC over `<timestamp>.<body>` with a 5 min tolerance helper; hosts resolved at send time and private addresses refused (narrows DNS rebinding, documented) |
| NF-09 | Fixed | Only the MCP transport can write to stdout; every other write goes to stderr |
| NF-10 | Open, Info | `TOKEN_DECIMALS` still comes from env, as in the native agent |
| NF-11 | Fixed | `accept_key` text says 30 Tgas everywhere; AGENTS.md counts updated |

## 2. Findings

### NF-01 [Medium] An MCP give-up is acked, whatever the reason

**Vulnerability.** `enforce` gives up the current invoice when `MCP_DECISION_TIMEOUT_S` passes or the tool-call limit is hit (`session.ts:114-116`). `giveUp` calls `done`, which calls `inbox.advance(state, item)` with the default `{ ack: true }` (`inboxClient.ts:107-108`). The item goes into the tick root. The background `tick` runs `enforce(false)` on a timer, so this happens even when no client is driving. `test/mcp.test.ts:306-332` asserts this ("ack it like `MAX_STEPS`").

The AG-03 fix drew a line in the native agent. A model that read the invoice and answered without deciding is acked (`MAX_STEPS`). An input the model never produced a verified answer on is left out (`MAX_ATTEMPTS`, `ack: false`). Over MCP the server only sees elapsed time and call counts, so both cases look the same and both are acked.

**Exploit scenario (owner frames the agent).**
1. The tester serves a lure whose `email` plus `document` is close to `MAX_INBOX_BYTES` (128 KB, `inboxClient.ts:21`). The agent accepts it.
2. `next_invoice` returns it plus the policy text. That is well over 50,000 characters and 25,000 tokens. Claude Code caps MCP output at 25,000 tokens by default and moves results over 50,000 characters to a file ([docs](https://code.claude.com/docs/en/mcp)), so the model does not see the invoice inline. Other clients truncate or error.
3. The model stalls or burns calls. After 30 minutes or 20 calls the server gives up and folds the item into the tick.
4. The agent acks the tick, the root matches the release, and `prove_delivery` scores the lure `Ignored`.

The same thing happens without an attacker when the client's model provider is down, or when Claude Desktop stays open with nobody prompting after a `next_invoice`. The contract checks only what the ack says, so it cannot catch this.

**Fix.**
- Ack a given-up item only if the model clearly worked on it after it was served: at least one further counted call on that invoice (`c.calls > 1`). Otherwise call `advance(state, item, { ack: false })`, like the AG-03 path.
- Cap what `next_invoice` returns well below common client limits (for example 40,000 characters of `email` plus `document`). For a larger item, return a short notice, give it up with `ack: false` and log it.
- Add a regression test: an item served and then left with no further call times out and stays out of the ack.

```ts
// BEFORE (session.ts:104)
const giveUp = async (c: Current, reason: string) => { await done(c.item); ... };
// AFTER
const giveUp = async (c: Current, reason: string) => {
  await d.inbox.advance(state, c.item, { ack: c.calls > 1 }); // AG-03: an item the model never worked on is not proven delivered
  current = null; ...
};
```

### NF-02 [Medium] Default caps follow the token's decimals blindly

**Vulnerability.** `DEFAULT_POLICY.daily_cap = '5000000'` and `max_per_payment = '2000000'` are tUSDC base units (6 decimals). `buildVaultPlan` accepts any `tokenId`. When `decimals !== 6` and the caller set neither cap, it only adds a warning (`plan.ts:270-271`) and returns `ok: true`. The web form sends `name`, `vendorId`, `tokenId` and `fundNear` only (`new.tsx:223,280`), so an owner who picks another token cannot follow the warning's advice.

**PoC (CONFIRMED).** A stub chain returning `ft_metadata { decimals: 2 }`:
```
true 5000000 2000000 [ "default daily_cap and max_per_payment are in 6-decimal units; tok.testnet has 2 decimals, so set them explicitly" ] 0
```
That is a 50,000-token daily cap and a 20,000-token per-payment cap instead of 5 and 2. With 0 decimals the caps are 5,000,000 and 2,000,000 tokens. The same run shows `payee_delay: '0'` is accepted (see NF-06).

**Impact.** The caps are the product's limit on how much a compromised or injected agent can lose. For a token with fewer than 6 decimals, a self-serve vault is signed with caps 100 to 1,000,000 times higher than the template promises. Tokens above 6 decimals get caps too small to use, which is safe but broken.

**Fix.** Scale the defaults to the token: `cap * 10^(decimals - 6)`. If `decimals < 6` and the scaled value is not exact, refuse with 422 (`VAULT_PLAN_REFUSED`) unless both caps are given. Expose the two caps in the web form, labeled with the token's symbol.

### NF-03 [Low] A full-access key can hide past the 20-key cut

**Vulnerability.** `readVault` returns `keys.slice(0, 20)` and builds `keySummary.items` from the same slice. Only `keySummary.count` covers every key (`view.ts:52-60`). The web shows "full-access keys" by filtering `v.data.keys` (`new.tsx:146-152`). The account is still classified `vault` whatever keys it holds.

**PoC (CONFIRMED, stub chain).** With 20 function-call keys and one `FullAccess` key last:
```
vault keys returned 20 count 21 full in keys 0 full in summary 0
```

**Exploit scenario (PLAUSIBLE).** `view_access_key_list` walks the trie, where keys sort by the borsh `PublicKey` (curve byte first). A `secp256k1` key therefore sorts after every `ed25519` key. The parent creates `name.owner` in one tx: `CreateAccount`, 20 `AddKey` function-call keys, one `AddKey` secp256k1 full-access key, `UseGlobalContract`, then `new` (the parent may call `new`, V21-03). The page reads "full-access keys 0". That key can call the vault's `#[private]` callbacks and `ft_transfer` as the vault, so the scorecard and the funds are not what the page implies. `scripts/verify-evidence.ts:92-99` checks every key and would catch it. The web page and the API do not.

**Fix.** Count over all keys on the server: return `keySummary.fullAccess` (and `nonAgentKeys`) computed before the slice, and have the web use it. Better still, add `trusted: false` with reasons when any key is full access or not an agent-scoped function-call key on the vault (reuse `keyScope` and the `accessKeys.test.ts` agent-scope rule).

### NF-04 [Low] Attacker-chosen ids flush the shared cache and fan out to RPC

**Vulnerability.** `cached()` is one process-wide `Map` capped at 500 that calls `clear()` when full (`ttlCache.ts:3,8`). Before this change, every public cache key was bounded: the scorecard route checks `companyFor` first (`publicRoutes.ts:166`), and evidence pages are keyed by registered shops. `GET /public/vault/:shopId` caches `vault-view:<any valid id>` before any registry check (`vaultRoutes.ts:102`). It caches `missing` and `foreign` results as well.

**Exploit.** At the route limit of 30 a minute per IP, about 17 IP-minutes of distinct names (`a0.testnet`, `a1.testnet`, ...) flush the cache. That drops the 30 s evidence pages and the 1Click token list. Evidence then rebuilds on every request (B23-01 keeps its 20/min limit but loses the cache), and each quote costs two upstream calls again (B23-04). Each uncached view also spends one `view_account`. A real vault spends 4 RPC calls plus one FastNEAR tx API call with the operator's key. Each plan spends 6 RPC reads, two of them view calls on an attacker-chosen `tokenId` contract. No global budget exists, unlike the 1Click proxy. Each 404 or 422 also writes an `ErrorLog` row, and `errorLogCleanup` keeps only the newest 10,000, so a flood of a few hundred requests a minute rotates real error records out within the hour.

**Fix.**
- Give each route its own bounded LRU (for example a `vault-view` cache of 200 entries that evicts the oldest), never a global `clear()`.
- Do not cache `missing` results, or cache them in a separate small LRU.
- Add a global sliding budget for `/public/vault*` chain reads, as B23-04 did for quotes.
- Skip the `ErrorLog` insert for expected public 404 and 422 responses (log to stdout only).

### NF-05 [Low] No lock on the MCP state file

**Vulnerability.** `mcpConfig` refuses only `resolve(MCP_STATE_PATH) === resolve(AGENT_STATE_FILE)`. `assertNoNativeAgent` checks the mtime of `AGENT_STATE_FILE`, default `./state.json`, resolved against the MCP client's cwd. Claude Desktop and Claude Code do not start the server in `agent/`, so the default path points elsewhere and the check passes silently. Nothing guards against two MCP servers sharing one `MCP_STATE_PATH`. Claude Code starts one stdio server per session, so two sessions with the documented `claude mcp add` line do exactly that.

**Impact.** Both processes load the same cursor, serve the same invoice to two models and sign with one key. The contract keeps one decision per invoice, so nothing is paid twice. But nonce clashes use up the 3-sign budget, both write `<state>.tmp` and rename it (one rename fails with `ENOENT` after a signed decision), and each acks the tick with its own partial root. A mismatched root leaves the tick's lures `Unanswered`, so the agent loses evidence it earned.

**Fix.** Take an exclusive lock at startup: `open(`${MCP_STATE_PATH}.lock`, 'wx')` with the pid, a stale-pid check and removal on shutdown. Require `MCP_STATE_PATH` and `AGENT_STATE_FILE` to be absolute in `mcpConfig`, or resolve them against the directory of `mcp.ts`.

### NF-06 [Low] The vendor arms without being shown what it agrees to

**Vulnerability.** `vendorView` turns `status.pending_key` into a ready `accept_key` call (`vendorView.ts:44-46`). The web copy says "The owner proposes it, you accept the same key" (`vendor.tsx:76-78`). The contract binds `accept_key` to the exact proposed key (`lib.rs:722-725`), which is good. Still, nothing asks the vendor to check that the key belongs to its own agent. The MCP `get_status` already shows `agent_key.public_key` and `pending_on_vault` for that check. The console's `limits` also leave out `payee_delay`, `limits_delay`, `min_answer`, `test_ttl` and `reveal_grace`. These are the fields that protect the agent from framing (V2-04, V23-05). The plan accepts `payee_delay: '0'` (NF-02 PoC) and the contract allows it.

**Exploit scenario.** The owner proposes a key it holds, and the vendor clicks Accept. The owner can then pay a lure with the "agent" key: `Failed`, demoted, and a public scorecard against the vendor's agent. With `payee_delay` 0, the owner can also delist and commit in the same block as an agent read.

**Fix.** Before the Accept button is enabled, have the vendor paste or confirm its agent's public key, and refuse when it does not equal `pendingKey`. Add the anti-framing fields to `limits`, and flag `payee_delay` below one hour or `min_answer` at the floor. Have `checkPolicy` warn when `payee_delay` or `limits_delay` is 0.

### NF-07 [Info] `createdTx` is not the creation transaction

`firstIncomingTxHash` returns the oldest tx with the account as receiver. FastNEAR indexes failed txs too. A `Transfer` sent to `shop.alice.testnet` before Alice creates it, or Alice's own first plan attempt that failed in `new`, becomes the "created" link. `createdTxs` caches it for the life of the process (`vaultRoutes.ts:42-49`). Fix: pick the first successful tx from the parent that holds `CreateAccount`, `UseGlobalContract` by `VAULT_CODE_HASH` and `new`, with no `AddKey`. That is the V21-04 rule `verify-evidence.ts` already applies. Return `null` otherwise.

### NF-08 [Info] Webhook signature and host rules

`signatureOf` signs the body only. Add a timestamp header and sign `<timestamp>.<body>`, so receivers can reject anything older than 5 minutes (Stripe and Slack do this). `isBlockedHost` checks literals only. A DNS name that resolves to 10.0.0.0/8, NAT64 `[64:ff9b::a00:1]` and IPv4-compatible `[::a00:1]` all pass. The URLs are operator config and `redirect: 'manual'` is set, so this matters only if config ever becomes tenant-supplied. When it does, resolve the name, check every address and pin the connection ([OWASP SSRF](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)). Missed alerts during downtime and dropped failed deliveries are documented in `backend/README.md:85` and are by design.

### NF-09 [Info] Stdout guard covers `console.log` only

`mcp.ts:14` reassigns `console.log`. Bun writes `console.info`, `console.debug`, `console.table` and `console.dir` to stdout. A grep of `near-api-js` and `@modelcontextprotocol/server` found no such call, so nothing breaks today. Redirect all of them, or wrap `process.stdout.write` so that only the transport may write.

### NF-10 [Info] Token decimals from env

`TOKEN_DECIMALS` (1 to 24) drives `toBaseUnits` and the `usdc` figures in `get_status`. At startup, read `ft_metadata` of `status.token_id` and refuse to start on a mismatch. The vault's contract caps still bound the loss.

### NF-11 [Info] Docs drift

`plan.ts:160` says 100 Tgas for `accept_key`, `vendorView.ts:7` sends 30 Tgas, and AGENTS.md says about 15 Tgas. Any of them works, because the contract needs about 15 Tgas and refunds the rest. AGENTS.md still expects 179 backend and 56 agent passes.

## 3. Checked and clean

| Area | Result |
|:-|:-|
| CLI injection in `plan.cli` | `ownerId`, `vaultId`, `tokenId` pass `isValidAccountId` (`[a-z0-9._-]`, alnum at the ends); `codeHash` is base58 from config checked at startup; amounts are bigints; JSON args go through `shq` single-quote escaping and hold only validated fields. near-cli-rs 0.30.1 accepts the whole `cli[0]` grammar (`receiver-id`, `use-global-hash`, `with-init-call`, `skip`) |
| Plan correctness | tx1 is one receipt: `CreateAccount`, `Transfer`, `UseGlobalContract`, `new`. If `new` fails, the receipt reverts and the deposit is refunded. Deposits are yocto strings; action shapes match `@hot-labs/near-connect` `ConnectorAction`; the vault gets no access key; `intents_id` is always null; mainnet needs `VAULT_PLAN_MAINNET` |
| Account ids to RPC and FastNEAR | Sent in JSON-RPC and JSON POST bodies, never in URLs; the FastNEAR key goes in a header to the configured host |
| `errorHandler` `details` | Spread before `code` and `message`, so it cannot override them; only field names, `vaultId` and a public code hash pass through |
| Vendor and owner authz | `/vendor/*` compares the JWT user's `walletAddress` with live `get_status.vendor_id`; `/company/alerts` needs `requireCompanyOwner`. The JWT holds only `userId`, so each role is decided per request and a vendor token gets 403 on owner routes and the reverse. Rate limits run before auth |
| Alert text | Chain strings are restricted to `[A-Za-z0-9._:-]`, at most 128 chars; Discord `allowed_mentions` is empty; zod strips unknown keys from `data` |
| MCP bypass attempts | `pay` and `propose` go through `runTool` with the live mode; preflight runs on the exact payee and amount; `invoice_id` must equal the current invoice; the sign cap counts every signing path; reads never sign; no `ack` tool; parallel calls are serialized (`locked`) |
| Prior fixes | AG-01 (one cursor for decide and ack), AG-02, AG-05 (header key, host match), AG-06 (`int` bounds, also for the MCP limits), AG-08 (`readBounded`) hold on the MCP path. AG-03 holds for thrown errors but not for MCP give-ups (NF-01). B23-01 and B23-04 hold, with the cache caveat in NF-04 |
