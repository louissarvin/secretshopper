# 29. Partner docs review: backend and agent (2026-11-06)

Sources: mirrors in `reference/` and the installed `@nearai/inference-sdk` 0.2.1. No live calls were made because we have no NEAR AI key.

## 1. NEAR AI

**API (from the docs).** Base URL `https://cloud-api.near.ai/v1`, OpenAI compatible.

| Endpoint | Auth | Notes |
|:-|:-|:-|
| `POST /chat/completions` | key | |
| `GET /v1/models` | none | `security: {}` |
| `GET /v1/attestation/report?model=&provider=near&signing_algo=&nonce=<64 hex>` | key, not billed | Send `x-no-aliasing: true`. Returns `gateway_attestation` and `model_attestations[]` (`intel_quote`, `event_log`, `request_nonce`, `signing_address`, `signing_algo`, `info.tcb_info.app_compose`, `nvidia_payload`) |
| `GET /v1/signature/{id}?signing_algo=` | key | Returns `text`, `signature`, `signing_address`, `signing_algo`, `signature_kind` |
| `GET /v1/attestation/ita-token` | none | Intel Trust Authority JWTs and `jwks_url` |

**Signatures.**
- `ecdsa` is EIP-191: recover the signer and compare it to `signing_address`.
- `ed25519` verifies the UTF-8 `text` against the hex public key.
- The signed text is `<model>:<sha256(req)>:<sha256(resp)>` for `provider_tee` and `<sha256(req)>:<sha256(resp)>` for `gateway`.

**Verification, end to end.**
1. Fetch a preflight report with your own nonce.
2. Verify the quote with DCAP and reject debug mode.
3. Check `report_data`: signer (32 bytes), then nonce (32 bytes).
4. Replay the RTMR3 event log.
5. Check `MRCONFIGID = 01 || sha256(app_compose) || zeros`.
6. Check GPU evidence through NRAS.
7. After the completion, the signer must match exactly one verified preflight report. A report fetched later does not count.
8. A `gateway` signature does not prove the model ran in a TEE.

The SDK runs all of these steps in `InferenceClient.fetch` and `verifyResponse`, even with `e2ee: false`. It also exports `verifyModelAttestation`, `verifyGatewayAttestation` and `verifyModelResponse` for offline re-checks.

**Gaps in our code**

| Where | Problem |
|:-|:-|
| `backend/src/lib/proof/receipt.ts:30-37`, `scripts/verify-evidence.ts:159-170` | Self-consistency only: the check compares the signer to the address stored in the same receipt. Any wallet passes, as `backend/test/receipt.verify.test.ts:10-28` shows. Nothing ties the key to a TEE. |
| `backend/src/tester/nearai.ts:46-58` | The code throws away `verified.attestation`, which holds the report, nonce and `tcbStatus`. Nobody can re-verify after the reveal, and once keys rotate the Verification Center may show "unable to verify". |
| `backend/prisma/schema.prisma:218-237` | No column for the attestation. A schema change needs the human. |
| `receipt.ts:32,37` | The raw hex goes to `ethers.verifyMessage` and addresses are compared as strings. The SDK strips an optional `0x`; ethers v6 rejects hex without it. If the wire omits the prefix, every lure fails at `nearai.ts:60`. |
| `receipt.ts:29` | ed25519 is not supported. The docs show a tweetnacl path. |
| `receipt.ts`, `verify-evidence.ts` | `gateway` receipts are treated the same as `provider_tee`. |
| `agent/index.ts:44`, `agent/src/loop.ts:26` | The agent uses the plain OpenAI client: no attestation, no receipts, no E2EE. |

**Models.** The docs define three tiers: Confidential TEE (model attested), 3P TEE, and Incognito (gateway only).
- **Agent:** `z-ai/glm-5.3-flash`. It is the docs' E2EE example and reasons by default. Under E2EE the SDK sets `x-encrypt-all-fields`, so tool definitions and tool calls are encrypted too.
- **Lures:** the RED abliterated models (`Qwen/Qwen3.8-27B-abliterated` first in `generator.ts:15`) are not in the mirrored docs; only v2/18 mentions them. Confirm with the public `GET /v1/models`, and require `provider_tee`.

## 2. NEAR Intents

- **Rail is correct.** `ft_transfer_call(receiver_id=intents.near, msg="<account>")` credits that account (`deposits.md`). Our `msg = payee` (`lib.rs:1501-1510`) matches. `receiver_id` is "always `intents.near`". No testnet exists.
- **Problem: rail cannot be enabled.** `scripts/create-vault.ts:81` hardcodes `intents_id: null`.
- **Problem: gas is tight.** The docs say 100 Tgas covers a deposit. We attach 60 + 10 Tgas (`lib.rs:11-12`) inside an 80 Tgas `pay` (`agent/src/config.ts:46`). [NEEDS VERIFICATION]
- **1Click dry quotes need no funds and no key.** `dry: true` creates no deposit address. Quotes carry `signature` and `timestamp`, which `verifyQuoteSignature()` checks (sdk 0.1.24 or later).
- **Payout preview request:** `originAsset nep141:17208628…133a1` (mainnet USDC), `depositType INTENTS`, a Base USDC destination, `recipientType DESTINATION_CHAIN`, `refundType INTENTS`.
- **Fee conflict.** Hackathon Q-006 says 0.2% without a JWT. The docs say an extra 0.25% without a key, and 0.20% (1 bp on stablecoins) with one (`resources/fees.md:32-33`).

## 3. OutLayer and Agent Market

**Agent Market fits.**
- **Setup:** an account with a confirmed email, a price, an `aat_` token, and a four-call loop: `GET /v1/agents/me/assignments`, then `start`, `messages`, `submit`.
- **Cost:** no public URL, no gas, 5% fee, USDC payouts.
- **Offer:** list a "vault audit" agent. The brief is a vault id; the deliverable is the `verify-evidence` output plus the scorecard.
- **Effort:** S to M. It proves a paid agent service.

**OutLayer has no cheap fit.**
- **Custody wallets** sign as their own implicit account, while our vault authorizes its own FC key. Using them would need predecessor auth (L) and would duplicate the vault policy.
- **VRF over HTTPS** can be re-rolled, because each call gets a new `request_id`. On chain, the output is public before the reveal.
- **Signing keys** (`bind: "wasm"`) could keep the agent key inside TDX and sign only transactions the module builds. Effort L; post-hackathon.

## 4. Ranked changes

| # | Change | Effort |
|:-|:-|:-|
| 1 | Persist the attestation report, nonce and `tcbStatus` per receipt (needs human approval for the schema change) and publish them. `verify-evidence` re-runs the SDK verifiers and labels gateway receipts as partial. | M |
| 2 | Harden `receipt.ts`: strip `0x`, check lengths, compare bytes, add ed25519, test with prefix-less vectors. | S |
| 3 | Agent on `InferenceClient` (`e2ee: true`) with `verifyResponse` on every step and receipts in the decision log. | S-M |
| 4 | A Verification Center link per revealed receipt: `cloud.near.ai/verify?model=…#receipt=<base64url JSON of the receipt fields>`. | S |
| 5 | Agent Market "vault audit" listing. | S-M |
| 6 | A create-vault option allowing only `intents.near`; about 120 Tgas for Intents pays; a public 1Click dry payout preview. | S |

**Can run today without a key:** `GET /v1/models` and `GET /v1/attestation/ita-token`.

**Open questions [NEEDS VERIFICATION]:**
- Do wire signatures and addresses carry the `0x` prefix?
- Do RED models return `provider_tee` signatures?
- Is 60 Tgas enough for USDC `ft_transfer_call`?
