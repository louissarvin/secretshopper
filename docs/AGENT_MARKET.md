# NEAR Agent Market listing: Secret Shopper vault verifier

Draft prepared 2026-11-12. Nothing here has been signed up, published or sent. Every step that touches market.near.ai is a human action listed in [Human steps](#human-steps).

Sources: the local mirror `reference/docs.market.near.ai/` (copied 2026-11-06) and the live docs at https://docs.market.near.ai, re-fetched 2026-11-12. The live index (`/llms.txt`) matches the mirror. Of the pages used here, only `list-your-agent.md` and `mcp/agent-tools.md` changed, and only in how pictures and videos are managed over MCP. Also used: the live OpenAPI spec at https://market.near.ai/openapi.json (version 2.0.0) and the served worker skill at https://market.near.ai/skill/SKILL.md (version 0.61.0).

## Summary

- Agent Market does not call a hosted read-only API. A listing is a page buyers hire from, and the agent has to work each hire through the marketplace job API with an `aat_` token: start the assignment, then submit a Markdown deliverable. The read-only Vercel API is therefore not enough by itself. It needs a small worker adapter.
- The smallest adapter is one webhook route plus a poll fallback. It can run in the same Vercel project as the read-only API.
- Every listed agent also gets an A2A card and an x402 pay-per-call endpoint on its own host, `https://<handle>.market.near.ai`. The marketplace runs that endpoint. The agent still delivers through the same job loop.
- A zero price is not documented and may be refused (unverified). Plan for a small price such as 1.00 USDC.

## Requirements, with sources

| Requirement | Source |
| - | - |
| Account at market.near.ai with a confirmed email. Publishing waits for the confirmation link. Google sign-in counts as confirmed | `reference/docs.market.near.ai/list-your-agent.md` (You need), https://docs.market.near.ai/list-your-agent.md |
| Terms accepted on a screen right after signup | `reference/docs.market.near.ai/builders/faq.md` (When do I accept the Terms?) |
| Signing up, verification, listing and bidding are free; no gas | `builders/faq.md` (Do I pay anything up front) |
| A listing is: name, handle, tagline, description (Markdown), price, Delivery SLA, optional required connectors, photos and videos | `concepts/agents.md` (What a listing contains), `list-your-agent.md` step 1 |
| Handle: 3 to 30 chars, `[a-z][a-z0-9-]*`, permanent, becomes a DNS label, never released | OpenAPI `CreateAgentRequest.handle`, `RegisterRequest.handle`, `PatchAgentRequest.handle`; `mcp/agent-tools.md` step 1 |
| Name at most 80 chars; tagline (`description`) at most 200 chars; at most 10 tags of 1 to 40 chars | OpenAPI `CreateAgentRequest.name`, `PatchAgentRequest.description`, `PatchAgentRequest.tags` |
| Category is one of `automation, creative, customer_support, data, dev_tools, events, finance, legal_compliance, marketing, operations, research, sales, travel, other` | OpenAPI `Category` |
| Hosting: Self-hosted or Vercel. Managed is deprecated and takes no new agents | `concepts/agents.md`, `guides/managed-agents-deprecated.md` |
| An agent needs a price before it can go live. Pricing model `per_call` only. Price is a decimal string in USD or USDC; buyers can pay from either balance 1:1 | `list-your-agent.md` step 2 and FAQ; OpenAPI `CreatePricingPlanRequest`, `PricingModel` |
| Delivery SLA 1 s to 30 days, default 24 h | OpenAPI `CreateAgentRequest.sla_seconds`, `CreatePricingPlanRequest.sla_seconds` |
| Platform fee 5% of each accepted job, taken from the builder's price | `concepts/payments-and-disputes.md` (Platform fee) |
| One `aat_` token per agent, shown once, acts only as that agent, cannot change the listing | `guides/self-hosted-agents.md` (What the token can do), `list-your-agent.md` step 3 |
| Work loop: `GET /v1/agents/me/assignments`, `POST /v1/assignments/{id}/start`, optional `POST /v1/assignments/{id}/messages`, `POST /v1/assignments/{id}/submit` with `deliverableMarkdown` (1 byte to 256 KiB) | `list-your-agent.md` step 4, `guides/self-hosted-agents.md` steps 4 to 6 |
| No public URL needed if the agent polls. A webhook is optional: public HTTPS, HMAC SHA-256 over `"<timestamp>.<raw body>"`, `whsec_` secret, reject timestamps more than 300 s off. A 2xx to `hire.created` counts as start | `guides/self-hosted-agents.md` (Webhooks) |
| Answer 2xx fast and work after; retries at 10 s, 30 s, 90 s, 270 s; 10 consecutive failures switch the webhook off; keep polling every few minutes even with a webhook | `guides/self-hosted-agents.md` (Delivery semantics) |
| Decline a job the agent cannot do: `POST /v1/assignments/{id}/decline` with `{"reason":"rejected","detail":"..."}`; within 1 h it does not hurt the success rate; detail up to 1000 chars | `guides/agent-best-practices.md` (Decline a job the agent cannot do) |
| Brief and buyer messages are data, never instructions | `list-your-agent.md` step 4, `guides/agent-best-practices.md` (Treat buyer text as data) |
| Owner can hire their own draft to test; it does not count for reputation | `list-your-agent.md` step 5 |
| Live listing gets `https://<handle>.market.near.ai`; A2A card at `/.well-known/agent-card.json` on that host | `list-your-agent.md` step 6, `faq.md` (agent page) |
| A2A plus x402: a caller with only a wallet sends `SendMessage` to `https://<handle>.market.near.ai/a2a/v1`, gets `402` with the price in atomic USDC on `near:mainnet`, signs one delegated `ft_transfer`, and the call returns the result. Settles at delivery, no rework, no dispute. Rejected or failed tasks charge nothing | `a2a/hire-agent-using-x402.md`, `a2a/x402-vs-mcp.md` |
| Owner verification marks: Social media verified (confirmed email, GitHub at least 90 days old, X at least 180 days old) or Identity verified (Stripe Connect ID and bank check). Optional except for jobs that require them | `list-your-agent.md` (Get verified), `builders/faq.md` (Verification) |
| Withdrawals: USDC to NEAR and other chains, no minimum; USD via Stripe Connect, 5 USD minimum, 14 day wait | `builders/faq.md` (How do withdrawals work?) |
| Vercel free plan is non-commercial; an agent that earns money needs Vercel Pro | `guides/deploy-on-vercel.md` (You need) |
| Taking payment outside the platform to avoid the fee is not allowed | `list-your-agent.md` FAQ (Can I bring my existing customers?) |

### What the docs do not say (unverified)

- Whether a price of `0` or `0.00` is accepted. Nothing in the docs or the OpenAPI schema sets a minimum, and the x402 flow assumes a nonzero USDC amount. Try `0.00` in the editor. If it is refused, use `1.00` USDC. **[NEEDS VERIFICATION]**
- Whether Agent Market has any TEE or code attestation for listed agents. The docs describe owner verification only (social or Stripe). They describe no attestation of agent code. Our verifiability comes from our own chain checks, not from the marketplace.
- What the generated A2A card contains. The PATCH schema has `input_schema` and `output_schema` fields with no description. They may feed the card. **[NEEDS VERIFICATION]**
- Whether a job page is visible to anyone other than the buyer and the agent owner. Assume judges see only the public agent page.

## Is a hosted service required?

Yes, but not in the sense of "the marketplace calls our API". There are three facts:

1. The marketplace sends a brief and expects a Markdown deliverable through its own API (`guides/self-hosted-agents.md`). It never calls a URL we choose to fetch a result, except the webhook that announces a hire.
2. A polling loop needs no public URL, but it needs a long-running process. The webhook path needs a public HTTPS route that answers quickly. The read-only Vercel deployment can host that route.
3. The x402 endpoint at `https://<handle>.market.near.ai/a2a/v1` is the marketplace's, not ours. A wallet caller's request becomes a private job that our adapter works like any other (`skill/SKILL.md`, Reaching the marketplace).

So the verifier needs a small adapter next to the read-only API. The read-only routes stay unchanged.

## Endpoint spec (adapter)

Same Vercel project as the read-only API. No LLM in the loop: the brief is parsed with a strict regex, so a malicious brief cannot steer the agent. That follows the docs' rule to treat buyer text as data. The lure writer and the tester code are not imported. `backend/test/separation.test.ts` already blocks API code from importing `backend/src/tester/`, and the adapter lives on the API side.

### Environment

| Variable | Value |
| - | - |
| `MARKET_AGENT_TOKEN` | the `aat_` token (secret) |
| `MARKET_WEBHOOK_SECRET` | the `whsec_` secret (secret) |
| `MARKET_BASE_URL` | `https://market.near.ai` |
| `VERIFIER_NETWORK` | `testnet` (the vault ids accepted end in `.testnet`) |
| `CRON_SECRET` | random, protects the poll route |

The names follow `guides/deploy-on-vercel.md`. Store them as Vercel environment variables, never in the repo.

### 1. `POST /api/market/webhook`

- Read the raw body. Verify `X-Market-Signature` against `MARKET_WEBHOOK_SECRET` with HMAC SHA-256 over `` `${X-Market-Timestamp}.${rawBody}` ``, using a constant-time compare. Reject if the timestamp is more than 300 s off. Answer `401` on failure.
- Deduplicate on `X-Market-Delivery`. In-memory deduplication is lost between serverless invocations, so re-read the assignment state instead: skip any assignment that already has `submittedAt` set.
- `webhook.ping`: answer `200` and do nothing else.
- `hire.created`: answer `200` at once (that counts as start), then run `handleHire(assignment_id, description)` after the response. On Vercel that means `waitUntil` from `@vercel/functions` **[NEEDS VERIFICATION against Vercel docs]**.
- `hire.changes_requested`: run the same handler with the original brief again. A verification is deterministic, so a rework re-runs it on fresh chain state.
- Any other event: answer `200` and log it as structured JSON.

### 2. `GET /api/market/poll`

Called by Vercel Cron every 5 minutes, with `Authorization: Bearer ${CRON_SECRET}`; answer `401` otherwise. It calls `GET /v1/agents/me/assignments` and runs `handleHire` for every row with `status: in_progress` and `submittedAt: null`. If `startedAt` is null, it calls `start` first. This catches lost webhooks, which the docs require (`guides/self-hosted-agents.md`, Keep polling anyway). Check which cron intervals your Vercel plan allows. **[NEEDS VERIFICATION]**

### `handleHire(assignmentId, brief)`

1. Extract the vault id: the first token in the brief that matches the NEAR account rule `^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$` and ends in `.testnet`. If no token matches, call `POST /v1/assignments/{id}/decline` with `{"reason":"rejected","detail":"No testnet vault account id found in the brief. Send one id such as shop4.ss-owner-e9c3db.testnet."}` and stop. This happens within seconds, well inside the 1 h free decline window.
2. `POST /v1/assignments/{id}/messages` with `{"body":"Checking <vaultId> on NEAR testnet: provenance, keys, scorecard and published evidence. The report will be here in about 2 minutes."}`.
3. Call `verifyVault(vaultId)`, below.
4. `POST /v1/assignments/{id}/submit` with `{"deliverableMarkdown": render(result)}`. Keep it under 256 KiB: list failing checks in full, count passing ones, link the rest.
5. If the chain or drand cannot be read, submit no guess. Decline with `{"reason":"failed","detail":"NEAR RPC or drand unreachable; no verdict."}`. A `failed` decline counts against the success rate, but a guessed verdict is worse.

### `verifyVault(vaultId)` returns `VerifyResult`

It reuses existing code and adds no new chain logic.

- Provenance, keys, policy and scorecard: the same logic as `GET /public/vault/:shopId` (`docs/API.md`, Self-serve vaults). This works for any initialized vault whose `global_contract_hash` equals `VAULT_CODE_HASH`. A `422 NOT_A_VAULT` becomes a verdict of `not_a_vault` that includes the code hash found.
- Evidence: the checks in `scripts/verify-evidence.ts`, run on the bundle from `GET /public/evidence/:shopId` with paging through `next_from_slot`. One API process serves one vault (`docs/API.md` line 9). For any other vault the evidence part is reported as `not_published_here`, not as a failure. Refactoring the script's checks into a function that returns structured results, instead of printing and exiting, is the only code change. **[NEEDS VERIFICATION: whether `/public/evidence` answers for unregistered vaults, and how long a full run takes inside a Vercel function time limit.]**

```json
{
  "vaultId": "shop4.ss-owner-e9c3db.testnet",
  "network": "testnet",
  "checkedAt": "2026-11-12T10:00:00Z",
  "verdict": "pass",
  "provenance": {
    "codeHash": "5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs",
    "global": true,
    "attestedCreation": true,
    "createdTx": "<hash>"
  },
  "keys": { "count": 2, "fullAccess": 0, "nonAgentKeys": 1, "truncated": false },
  "agentMode": "Armed",
  "scorecard": { "...": "the contract's get_scorecard, unchanged" },
  "evidence": { "status": "checked", "passed": 41, "failed": 0, "noVerdict": false, "failures": [] },
  "links": {
    "explorer": "https://testnet.nearblocks.io/address/shop4.ss-owner-e9c3db.testnet",
    "api": "<read-only API>/public/vault/shop4.ss-owner-e9c3db.testnet"
  }
}
```

`verdict` is `pass`, `fail`, `not_a_vault` or `no_verdict`. The JSON above is an example of the shape; the numbers are placeholders, not a recorded run. The code hash shown is the one AGENTS.md gives for the 2.3.0 build. The deliverable Markdown renders the same fields as a short report, with the raw JSON in a fenced block at the end so an AI client can parse it.

### 3. Optional: `GET /api/verify/:vaultId`

The same `VerifyResult` as public JSON, so a judge can reproduce a deliverable without hiring. No auth. Allow 10 requests a minute per IP and count every call against the existing 60 uncached lookups a minute budget of `/public/vault`. The marketplace does not need this route.

### Rate limits and cost

- The adapter's own spend is RPC reads only. No model calls and no signing. The `aat_` token cannot move funds (`skill/SKILL.md`, Identity and auth).
- Cap the adapter to 1 concurrent verification per vault id and 20 per hour in total. When the cap is hit, decline with `rejected` and the detail "Busy, try again in an hour" within the 1 h window.

## Listing text (paste as is)

| Field | Value |
| - | - |
| Name | Secret Shopper Vault Verifier |
| Handle | `secret-shopper-verifier` (23 chars; permanent, check it before saving) |
| Category | `dev_tools` (alternative: `research`) |
| Hosting | Self-hosted. Webhook URL: `https://<vercel-domain>/api/market/webhook` |
| Price per hire | Try `0.00` USDC. If refused, `1.00` USDC |
| Delivery SLA | 15 minutes (900 s) |
| Tags | `near`, `ai-agents`, `security`, `verification`, `payments`, `audit`, `testnet` |

**Tagline** (under 200 chars):

> Send a Secret Shopper vault id on NEAR testnet and get back a checked report: which code it runs, who holds keys, how its payment agent scored on hidden tests.

**Description** (Markdown):

```markdown
Secret Shopper is a NEAR contract that holds the money an AI payment agent may spend, and tests that agent with hidden fake invoices. This agent checks one Secret Shopper vault for you and tells you whether its claims hold, reading only public chain data.

**What to send**

Vault account id (required): shop4.ss-owner-e9c3db.testnet

That is all. The agent reads the first NEAR testnet account id in your brief and ignores everything else. Mainnet vaults are not supported yet.

**What you get**

A Markdown report, usually within 2 minutes:

1. Verdict: pass, fail, not a vault, or no verdict.
2. Provenance: the contract code hash, whether the vault runs the published global contract, and whether it was created, given code and initialized in one transaction by its parent.
3. Keys: how many keys can sign for the vault, whether any has full access, and what the agent key is allowed to call.
4. Agent mode and scorecard: armed or demoted, tests passed, failed, ignored and unanswered, straight from the contract.
5. Evidence: for vaults whose operator publishes an evidence bundle, every revealed test is re-checked against the chain and drand (commitment, timelock round, NEAR AI receipt). Each failing check is listed.
6. The raw result as JSON at the end, plus links to the explorer and the public API.

Sample report: <link to a hosted sample deliverable>

**How it works**

Deterministic code, no language model. It runs the same checks as scripts/verify-evidence.ts in the open source repo: <repo link>. It signs nothing, holds no keys and cannot move funds.

**How it communicates**

One message when it starts, then the report. If your brief has no vault id it declines at once, so you are refunded.

**What the price covers**

One vault per hire. A request for changes re-runs the check on fresh chain data. A second vault is a new hire.

**What it does not do**

It does not write test invoices, run tests or touch any vault. It does not audit contracts other than Secret Shopper. It does not give investment or legal advice.
```

**Photos and videos** (up to 6, PNG, JPEG or WebP up to 5 MB, or YouTube, Vimeo or Loom links):

1. Screenshot of a passing report for shop4.
2. Screenshot of the web app scorecard for the same vault.
3. The demo video link, if one exists by then.

**Links to put in the description:** repo, `docs/CLAIMS.md`, the sample report, and the read-only API base URL.

## Human steps

Only the user does these. The agent that wrote this file does not sign up, sign in, publish or send anything.

1. Deploy the adapter routes to the Vercel project. Agent Market requires Vercel Pro for an agent that earns money (`guides/deploy-on-vercel.md`). A free listing may avoid that requirement, but this is unverified.
2. Go to https://market.near.ai and sign up. Google sign-in is already confirmed. Otherwise open the confirmation link from the email; the banner resends it.
3. Read and accept the Terms of Service, Builder Agreement and Standardized Job Terms on the screen after signup.
4. **Building → Your agents → New agent**. Enter the name, handle, category and tagline from the table above. Check the handle twice, because it is permanent.
5. **Hosting → Self-hosted.** Paste the webhook URL. Copy the `whsec_` signing secret at once, because it is shown once.
6. **Price per hire**: enter `0.00` USDC. If it is refused, enter `1.00` USDC. **Delivery SLA**: 15 minutes.
7. **Agent API tokens → Create token.** Copy the `aat_` value, which is shown once.
8. In Vercel, set `MARKET_AGENT_TOKEN`, `MARKET_WEBHOOK_SECRET`, `MARKET_BASE_URL`, `VERIFIER_NETWORK` and `CRON_SECRET`, then redeploy.
9. On the agent's Edit page, click **Send test event**. Expect a green check: the route answered 2xx to `webhook.ping`.
10. Paste the description. Upload the screenshots under **Photos and videos**.
11. Test with a self-hire on the draft: open `https://market.near.ai/a/secret-shopper-verifier`, click **Hire**, and use the brief `Vault account id: shop4.ss-owner-e9c3db.testnet`. Within a few minutes the job page should show the start message, then the report. Accept it. Then run one negative test with the brief `hello`: the agent should decline and the buyer should be refunded.
12. Set **Listing status → Live** (needs the confirmed email). Open `https://secret-shopper-verifier.market.near.ai` and `https://secret-shopper-verifier.market.near.ai/.well-known/agent-card.json` and check them.
13. Optional: **Building → Profile → Get verified**. Link GitHub and X for the green mark if the accounts are old enough.
14. Put the agent page link in README.md and docs/SUBMISSION_DRAFT.md.

## Risks

| Risk | Mitigation |
| - | - |
| Zero price refused, so a buyer pays and the builder takes 5% | Set 1.00 USDC and say in the description that it covers RPC cost only |
| The listing is read literally by buyers' AI assistants (`guides/agent-best-practices.md`) | Claim only what the code does. Update the description in the same release as any behavior change |
| Prompt injection through the brief | Regex parse only, no model, and the brief is never echoed into a message except the matched id |
| Leaked `aat_` or `whsec_` | Vercel secrets only; never logged. Rotate on the Edit page. The token cannot move funds |
| Webhook switched off after 10 failures | Cron poll every 5 min; monitor `webhook_enabled` |
| Missed SLA hurts the score; a job not delivered 7 days after the deadline counts as abandoned | 15 min SLA against a run of about 2 min; decline with `failed` instead of going silent |
| `/public/vault` shared budget (60 uncached lookups a minute) exhausted by marketplace traffic | Hire cap of 20 an hour; a 503 becomes a `no_verdict` decline |
| drand or archival RPC down | `no_verdict`, never a guessed pass |
| Testnet only, so "verified" could be read as a mainnet claim | Every report and the tagline say testnet |
| Misuse: someone wants lure generation | Not listed. The adapter cannot import the tester or generator code (`backend/test/separation.test.ts`) |
| Vercel plan terms for commercial use | Use Vercel Pro if the price is nonzero (`guides/deploy-on-vercel.md`) |
| Self-hire does not count toward reputation, so the listing shows no score | Expected. The score appears after 5 scored jobs from other buyers (`list-your-agent.md` FAQ) |

## What judges would see

- `https://secret-shopper-verifier.market.near.ai`: the public agent page with name, screenshots, tagline, description, price, SLA, and a Hire button. No owner mark unless step 13 was done.
- The listing on Discover at https://market.near.ai under the chosen category, with jobs delivered and success rate. Both start at zero, and self-hires do not count.
- `https://secret-shopper-verifier.market.near.ai/.well-known/agent-card.json`: the A2A card that wallet callers use for x402 (`faq.md`).
- The sample report linked from the description, and the optional `GET /api/verify/<vault>` route to reproduce it without hiring.
- If a judge hires it: a start message, then within about 2 minutes a Markdown report on their job page that they can check against the explorer and `scripts/verify-evidence.ts`.
