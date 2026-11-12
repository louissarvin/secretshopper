# 35. Security audit: agent harness (`agent/`)

Date: 2026-11-10. Auditor: security-auditor agent. Scope is the agent package only; `backend/` and `contracts/` were read for context and not changed.

## 0. Scope, method, status legend

| Item | Detail |
|:-|:-|
| Code | `agent/index.ts`, `agent/src/*.ts` (acks, config, inbox, llm, log, loop, merkle, policy, preflight, tools, vault, vendor), `agent/test/*` |
| Libraries | near-api-js 7.4.0 (nonce manager and gas-key lanes read in `node_modules/near-api-js/lib/index.js`), @nearai/inference-sdk 0.2.1 (`verifyResponse`, `docs/verification-guide.md`) |
| Contract rules relied on | `contracts/shop/src/lib.rs` 2.3.0: `pay`, `decline`, `propose`, `ack`, `check_delivery`, `check_rail`, `transfer`; [v2/32](32_delivery_proof_design.md), [v2/33](33_audit_230.md) |
| Threat model | Agent operator's side: a malicious inbox item, a malicious or compromised backend API, an unverified model reply, gas-key allowance burn and lane use, ack integrity, secret logging, the Intents rail |
| References | [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/), [LLM05:2025 Improper Output Handling](https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/), [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/), [LLM10:2025 Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/); NEAR [Gas Keys](https://docs.near.org/protocol/accounts-contracts/gas-keys) and [Access Keys, allowance](https://docs.near.org/protocol/accounts-contracts/access-keys) (mirrored in `reference/near-docs/protocol/accounts-contracts/`) |

Status legend:
- **CONFIRMED**: a proof of concept ran with `bun test` against the code before the fix, and a regression test now holds.
- **PLAUSIBLE**: follows from the code path; the trigger was not exercised against a live service.

Proofs of concept live in the session scratchpad (`scratchpad/poc/fork.test.ts`, `scratchpad/poc/flood.test.ts`, Appendix A). Before the fixes both passed (the attack worked). After the fixes both fail, which is the intended result.

No High or Critical finding. No path was found that makes the agent sign a method other than `pay`, `decline`, `propose` or `ack`, pay a payee the vault does not approve, or pay through the Intents rail to any contract other than the vault's own `intents_id`.

## 1. Findings table

| ID | Severity | Component | File:line (before fix) | Description | Status | Fixed |
|:-|:-|:-|:-|:-|:-|:-|
| AG-01 | Medium | Ack loop | `src/acks.ts:54-72`, `index.ts:85-86` | The ack walk read the inbox with its own cursor, separately from the decision loop. A backend that answers the two walks differently gets a lure into a signed root that the model never saw | CONFIRMED | Yes |
| AG-02 | Medium | Tool runner | `src/loop.ts:39-49`, `src/tools.ts:141,166` | No limit on signed calls per invoice. One injected reply with N `pay` calls signs N transactions, each burning key gas when the contract refuses it | CONFIRMED | Yes |
| AG-03 | Medium | Ack loop, retry path | `index.ts:111-113` with `src/acks.ts:54-72` | An invoice given up after `MAX_ATTEMPTS` model failures stayed in the ack. A backend can serve an item the model cannot process and turn a lure into a scored `Ignored` | PLAUSIBLE (trigger), CONFIRMED (folding) | Yes |
| AG-04 | Low | Model verification | `src/loop.ts:32` | A `gateway` receipt passed verification for the production agent. It proves only what the Gateway signed, not that the attested model produced the reply | PLAUSIBLE | Yes |
| AG-05 | Info | Secrets | `src/vault.ts:56` | The FastNEAR key went to any host ending in `fastnear.com`, including `evilfastnear.com` | CONFIRMED (unit test) | Yes |
| AG-06 | Low | Config | `src/config.ts:32,39,48-50` | Numeric settings were `Number(...)` with no bounds. A typo gave `NaN` gas, a zero poll interval or a broken amount regex | CONFIRMED (unit test) | Yes |
| AG-07 | Low | Policy design | `src/vendor.ts:26-28`, `src/preflight.ts:44-56` | Approved payees are vault-wide, not bound to a vendor. An injected invoice from vendor A can get vendor B's approved payee paid, within the caps | PLAUSIBLE | Yes (agent side, no contract change) |
| AG-08 | Low | Inbox client | `src/inbox.ts:26`, `src/loop.ts:24` | No size limit on an inbox response or on the item sent to the model | PLAUSIBLE | Yes |
| AG-09 | Info | Policy design | `src/tools.ts:151` | The amount is bound to the invoice by the prompt only. Code bounds it by `max_per_payment` and the daily cap | By design | No |
| AG-10 | Info | Decline reason | `src/tools.ts:139` | The 140-byte decline reason is model text published in the contract event log, so injected text can reach a public event | By design | No |

## 2. Attack surface map

| Entry point | Source | Trust | Guard |
|:-|:-|:-|:-|
| `GET /next`, `GET /vendors/:id` | Backend API (owner) | Untrusted content, authenticated transport | zod: 64-hex id, ISO `receivedAt`; vendor id regex; email and document passed as data |
| Model reply | NEAR AI Cloud | Verified per step | `verifyResponse(id)` over the captured request and response bytes before any tool runs; `provider_tee` required in `index.ts` (AG-04) |
| Tool `pay` / `propose` | Model | Untrusted arguments | Invoice id must equal the current one; account id regex; decimal amount; rail gated on `intents_id`; preflight on chain facts; `pay` only on `allow`; budget (AG-02) |
| Tool `decline` | Model | Untrusted arguments | Current invoice only; 140-byte UTF-8 cap; budget (AG-02) |
| Tools `get_vendor`, `check_account` | Model | Read only | Id regexes; approved payees replaced with `get_payees` from the vault |
| `ack(release_at, root)` | Harness, not a model tool | Signed by the agent key | Root over ids the decision loop decided or found decided (AG-01, AG-03); only when Armed or Demoted with this key |
| NEAR RPC, FastNEAR | Operator config | https or localhost only | Single provider; network error never reads as "account missing"; preflight read failure blocks |

## 3. Detailed findings

### AG-01 [Medium] A forked inbox gets an unseen lure into the ack

**Vulnerability.** `syncAcks` walked the inbox with `AckState.cursor` and folded every item it saw into the tick root (`src/acks.ts:54-72`). The decision loop then fetched the same endpoint with its own `state.cursor` (`index.ts:86`). Nothing tied the two walks together. Each poll makes two identical `GET /next` calls in a row, so the backend can tell them apart by order.

**Reproduction.** `scratchpad/poc/fork.test.ts` (Appendix A) ran against the code before the fix:
1. The backend serves `REAL` and `LURE` to the ack walk, and only `REAL` to the decision walk.
2. `syncAcks` signs `merkleRoot([REAL, LURE])`, which equals the tester's release root.
3. The decision loop never presents `LURE` to the model.

Result: `1 pass`. At reveal, `check_delivery` accepts the matching ack and `LURE` scores `Ignored`.

**Impact.** The owner, who runs the backend, can frame an honest agent with scored `Ignored` outcomes and lower its published pass rate at will. This is the same class as V23-04 to V23-07 in [v2/33](33_audit_230.md). No funds move.

**Fix.** The decision loop is now the only inbox reader. An item enters a tick only when the loop is done with it, through `advance` (`src/inbox.ts:67`) calling `noteDone` (`src/acks.ts:53`). `closeTicks` (`src/acks.ts:63`) closes a tick when the loop's next item is from a later tick, or when the inbox stays empty past `TICK_SETTLE_MS`. A closed tick is never reopened. `loadState` drops `open` and `pending` ticks left by the old walk (`src/inbox.ts:48`). 2.3.0 was never deployed, so no live state is affected. If the backend forks, the agent signs a root over what it decided. That root mismatches, which is on-chain evidence of the fork and blocks `Ignored` for that tick.

**Trade-off.** An ack now waits until the decision loop has worked through its tick. That delay is minutes against a `min_answer` of at least `test_ttl / 4`. A late ack can only leave a lure `Unanswered`, never `Ignored`.

**Regression.** `test/acks.test.ts`: `AG-01: a forked inbox cannot put an id the decision loop never finished into an ack`, `AG-01: a closed tick is never reopened by a late or out-of-order item`. `test/config.test.ts`: `AG-01: ticks from the old independent ack walk are dropped on load`.

### AG-02 [Medium] One reply can sign an unbounded number of transactions

**Vulnerability.** `createAgentLoop` ran every tool call in a reply (`src/loop.ts:39-49`). A failed `pay` came back as non-final output, so the loop kept going. Nothing counted signed calls per invoice (OWASP LLM06 Excessive Agency, LLM10 Unbounded Consumption).

**Reproduction.** `scratchpad/poc/flood.test.ts`: a scripted reply holds 50 `pay` calls to an approved payee, and the chain refuses each one with `payment count limit reached`. Before the fix this produced 300 signed transactions in one invoice (50 calls over 6 steps). The test asserted `sent === 300` and passed. After the fix the same test fails with `Received: 3`.

**Impact.** Each refused call burns the gas it used from the classic key's allowance or the gas key's balance. Unused prepaid gas comes back, according to the NEAR access-key and gas-key docs. Once the daily payment count is reached, which is a normal state on a busy day, one injected invoice can burn hundreds of transactions' worth of gas. A few such invoices exhaust a key funded with at most 1 NEAR. The agent then cannot decide or ack until the owner and vendor re-arm it. V21-01 keeps demotion working, so there is no fund loss.

**Fix.** `createRunTool` keeps a budget of `MAX_SIGNS_PER_INVOICE = 3` (`src/tools.ts:44`), spent only right before a chain call (`src/tools.ts:153,180`). That allows one refused pay, a retry and a decline. Validation errors and preflight refusals spend nothing. The counter survives `MAX_ATTEMPTS` retries of the same invoice.

**Regression.** `test/tools.test.ts`: `AG-02: at most three signed calls per invoice, however many the model asks for`, `AG-02: a preflight refusal leaves the budget for the decline`.

### AG-03 [Medium] A given-up invoice was acked

**Vulnerability.** After `MAX_ATTEMPTS` thrown errors, `index.ts:111-113` advanced past the invoice. The ack walk had folded it in regardless. Errors that throw come from the NEAR AI call or its verification. A backend controls one of them: an item too large for the model's context window fails every attempt.

**Impact.** The owner serves a lure the model cannot process, the agent gives up, the tick root matches, and the lure scores `Ignored`. That frames the agent for an input it never got a verified model answer on. The trigger was not run against NEAR AI, so it is PLAUSIBLE. The folding itself is CONFIRMED by the AG-01 proof of concept, because the old walk folded every item it was shown.

**Fix.** `advance(state, item, { ack: false })` on the give-up path (`index.ts:114`). The item is skipped but kept out of the root, so that tick's ack mismatches and nothing in it can be proven `Ignored`.

**Regression.** `test/config.test.ts`: `AG-03: an invoice given up after repeated failures stays out of the ack`.

### AG-04 [Low] Gateway-signed receipts were accepted in production

**Vulnerability.** The SDK accepts a `gateway` signature for a request to an attested model (`dist/node.js` `verifyResponse`, gateway branch). The SDK guide says such a receipt "does not by itself prove model execution". `loop.ts` logged `signature_kind` but did not check it.

**Impact.** A compromised but still attested Gateway could return its own tool calls with a valid `gateway` receipt. Signing still passes the preflight and the contract, so the impact is limited to decisions inside policy. It also weakens the claim that every decision came from a TEE model.

**Fix.** `createAgentLoop({ requireProviderTee })` throws before any tool runs when the receipt is not `provider_tee` (`src/loop.ts:34`). `index.ts:51` sets it. The option defaults off so the evaluation scripts can keep the Gateway-only client (`scripts/pass-rate.ts`).

**Regression.** `test/loop.test.ts`: `AG-04: with requireProviderTee a Gateway-signed reply runs no tool`.

### AG-05 [Info] FastNEAR key host check was a suffix match

`new URL(url).hostname.endsWith('fastnear.com')` matched `evilfastnear.com`. The RPC URL is operator config, so exploiting this needs a misconfigured or lookalike URL. Fixed with `isFastnearHost` (`src/vault.ts:53`), which accepts `fastnear.com` and its subdomains only. Regression: `test/config.test.ts`, `AG-05`.

### AG-06 [Low] Unvalidated numeric config

`Number(process.env.X || d)` turned a typo into `NaN`. `teraToGas(NaN)` fails every signature. `AGENT_POLL_MS=0` busy-loops the inbox. `TOKEN_DECIMALS=0` builds an invalid regex. Each value is now a bounded integer checked at start (`src/config.ts:17`). Intents pays need at least 120 Tgas because the contract attaches 100 Tgas to `ft_transfer_call` plus a callback. Regression: `test/config.test.ts`, `AG-06`. It runs `config.ts` in a subprocess with placeholder values from a temp directory, so no `.env` is loaded.

### AG-07 [Low] Approved payees are not bound to a vendor

`get_vendor` lists every active payee on the vault for any vendor id (`src/vendor.ts:26-28`), and the preflight allows any approved payee. An email that impersonates vendor A and names vendor B's approved account passes every code check. Funds go to a legitimate vendor, not the attacker, and are recoverable through normal business process. For lures the contract scores this `Misdirected`. Recommendation: store an approved-payee-to-vendor link on chain, or at least a vendor label the preflight compares with the invoice's vendor id. Fixed on 2026-11-11 without a contract change: the contract already stores an owner-set `label` per approved payee (`add_payee`). The loop passes the invoice's `vendor_id` to every tool call, and the preflight compares the payee's on-chain label with the vendor's legal name on file (`labelMatchesVendor` in `src/preflight.ts`: case, punctuation and company-form words ignored, whole words only). A mismatch is `payee_vendor_mismatch` and an invoice with no vendor on file is `invoice_vendor_unknown`. Both are warn, so `pay` is refused and a demoted agent can only `propose` to the owner. The vendor name still comes from the inbox, so a compromised backend could lie about it; the label itself is on chain. Regression: `test/preflight.test.ts` "AG-07".

### AG-08 [Low] Unbounded inbox payloads

`res.json()` reads any body size (`src/inbox.ts:26`), and the whole `email` and `document` go to the model (`src/loop.ts:24`). A compromised backend can cost the operator memory and inference spend. Since AG-03 is fixed, it can no longer turn the resulting failures into `Ignored`. Fixed: `readBounded` in `src/inbox.ts` reads at most `MAX_INBOX_BYTES` (128 KB, twice the API's 64 KB intake `bodyLimit`) and refuses a larger `content-length` before reading; an oversized body is an error the main loop logs and retries, so no item id is needed and nothing reaches the model. Regression: `test/config.test.ts` (AG-08).

### Info items

- **AG-09.** "Pay at most the invoice amount" is a prompt rule. Code bounds the amount only by `max_per_payment`, `daily_cap` and the preflight. This stays deliberate because it is part of what the lures measure, as SS-A01 in [v2/21](21_security_audit.md) noted.
- **AG-10.** The decline reason is model output published in the `Declined` event. It is capped at 140 bytes and is never interpreted by the agent. Indexers and UIs should render it as text.

## 4. Checked and sound

| Area | What was checked | Result |
|:-|:-|:-|
| Method surface | `vault.ts` signs only `pay`, `propose`, `decline`, `ack` with `deposit: 0n`; the model reaches the first three through a fixed `switch`; unknown tool names and non-function tool calls are refused | Sound |
| Invoice binding | `invoice_id` must equal the current invoice before any chain call; signatures always use `ctx.invoiceId`, never the model's string | Sound |
| Payee policy | `pay` only on preflight `allow`, which needs `approved_payee.active` from `get_payee_status` on chain; any read error is `block`; `listed_only` defaults to true so the contract refuses unapproved payees too | Sound |
| Backend vendor data | `createGetVendor` drops `approved_payees` and `approvedPayees` from the backend record and substitutes `get_payees`; extra backend fields can mislead the model only, and the preflight stops the payment | Sound |
| Intents rail | Offered only when `INTENTS_CONTRACT_ID` equals the vault's `intents_id`; the contract's `transfer` sends `ft_transfer_call` to its stored `intents_id` with the payee only in `msg`; the agent never passes a receiver; the vault, token and Intents ids are reserved and blocked as payees | Sound |
| Model verification | `verifyResponse` checks the signature over the exact captured request and response bytes (encrypted bytes under E2EE); a failed check throws before `runTool` (`loop.test.ts`); retries re-fetch the signature only, never the inference | Sound (plus AG-04) |
| Gas-key lanes | near-api-js 7.4 `NonceManager` reads `view_gas_key_nonces`, rotates lanes, and on `InvalidNonce` refetches only that lane; `key_nonces` is fixed at `new`, so the key type never changes under the cache; a re-key after demotion raises nonces and resolves through the same refetch | Sound |
| Allowance burn | Gas is credited back on refund for both key kinds, so only burnt gas counts; remaining exposure was the call count, now bounded (AG-02); acks are one per tick, contract-capped at 48 per 24 h, with exponential backoff | Sound after AG-02 |
| Double signing | `getDecision` before processing; the contract allows one decision per invoice; near-api-js retries resend the same signed transaction; `ack` is once per tick on chain and `acked` is persisted | Sound |
| Ack content | Ids are 64-hex validated, deduplicated, sorted; the root uses the domain-separated tree shared with the backend and contract (`merkle.test.ts`); a differing root is still signed as evidence | Sound |
| Secrets | `AGENT_PRIVATE_KEY`, `NEARAI_API_KEY_AGENT`, `INBOX_TOKEN` and `FASTNEAR_API_KEY` are never put in a log field; the startup log carries ids and flags only; `errMessage` logs `Error.message`, and SDK errors carry codes, not headers; the state file holds cursors and roots only | Sound |
| Transport | `INBOX_URL`, `NEARAI_BASE_URL`, `NEAR_RPC_URL` and `NEAR_TX_API_URL` must be https, or http on localhost | Sound |
| Isolation | No database URL and no `backend/` import (`separation.test.ts`) | Sound |

## 5. Priority

1. AG-01 and AG-03 are fixed. Deploy them before any 2.3.0 vault starts scoring `Ignored`, because they close the agent-side framing paths that remain after V23-04 to V23-07.
2. AG-02 is fixed. It matters most for gas-key vaults, where the key balance is the agent's only gas budget.
3. AG-04 is fixed for the production entry point. Keep Gateway-only clients to evaluation scripts.
4. AG-08 is next: a 32 KB body cap in `inbox.ts`.
5. AG-07 is fixed agent side (2026-11-11); a per-vendor payee map on chain would also bind it against a lying inbox.

Files changed: `agent/index.ts`, `agent/src/acks.ts`, `agent/src/inbox.ts`, `agent/src/tools.ts`, `agent/src/loop.ts`, `agent/src/vault.ts`, `agent/src/config.ts`, `agent/test/acks.test.ts`, `agent/test/tools.test.ts`, `agent/test/loop.test.ts`, new `agent/test/config.test.ts`.

Verification on 2026-11-10 (Bun 1.4.4):

```
$ cd agent && bun test
 50 pass
 0 fail
 193 expect() calls
Ran 50 tests across 8 files.
$ bun run typecheck   # tsc, no errors
```

`scripts` also typechecks clean (`cd scripts && bun run typecheck`). AGENTS.md still lists the old agent tail of 41 tests across 7 files.

## Appendix A. Proofs of concept (scratchpad, run before the fix)

`fork.test.ts` (AG-01), passed before the fix:

```ts
let call = 0;
const forked = async (c: Cursor | null): Promise<InboxItem | null> => {
  call++;
  const ackWalk = call <= 3; // syncAcks walks first: REAL, LURE, null
  if (ackWalk) return !c ? item(REAL) : c.afterId === REAL ? item(LURE) : null;
  return !c ? item(REAL) : null; // decision walk: LURE is skipped
};
await syncAcks(st, d);
expect(seenByDecisions).toEqual([REAL]);
expect(signed).toEqual([merkleRootHex([REAL, LURE])]); // matches the tester's root
```

`flood.test.ts` (AG-02), passed before the fix and fails after it with `Received: 3`:

```ts
const tool_calls = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, type: 'function', function: { name: 'pay', arguments: args } }));
await loop(item, 'Armed', 'Co', createRunTool(deps), false);
expect(sent).toBe(300); // 50 calls x 6 steps, each a signed transaction
```
