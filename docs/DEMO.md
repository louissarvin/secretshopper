# Secret Shopper: manual test and demo video (2:00)

Everything here runs on NEAR testnet or on a local NEAR sandbox. Nothing in this guide touches mainnet funds. tUSDC is our own test token and has no value.

Live vault: [`shop4.ss-owner-e9c3db.testnet`](https://testnet.nearblocks.io/address/shop4.ss-owner-e9c3db.testnet). Web app on http://localhost:3200, API on http://localhost:3700.

## Part 1. Test it by hand

There are four roles. The vault is the referee between them.

| Role | Wallet or key | What they do | Where |
|:-|:-|:-|:-|
| Visitor | None | Read the public scorecard, open a revealed test, recompute its proofs in the browser | `/s/shop4.ss-owner-e9c3db.testnet` |
| Owner (the company) | Full-access key of `ss-owner-e9c3db.testnet` | Sign in (NEP-413), add vendors and invoices, approve proposals, freeze, propose a new agent key | `/app` |
| Agent vendor | Full-access key of `ss-vendor-e9c3db.testnet` | Co-sign (accept) the agent key. Nothing else | NEAR CLI (no page signs `accept_key`) |
| Agent | A NEP-611 gas key on the vault, `pay,decline,ack` while Armed | Reads its inbox, decides each invoice through NEAR AI, signs `pay`, `decline`, `propose` and `ack` | `agent/` process |

The tester (lure writer) is a separate backend process with its own key. It never appears in the app.

### No wallet: check real data (2 minutes)

1. Open `/s/shop4.ss-owner-e9c3db.testnet`. See the score read from the contract: 87.50% (7 passed, 1 failed, 1 void), mode, agent key and delivery coverage.
2. Open a passed test, for example `/s/shop4.ss-owner-e9c3db.testnet/tests/7`. See:
   - the lure exactly as the agent received it (document and email);
   - the timeline from commit to reveal, with tx links;
   - click **Recompute in my browser**: COMMITMENT, INVOICE ID and RECEIPT HASH each read MATCH (before the click the panel reads NOT CHECKED and the inputs are masked on purpose). **Tamper one byte** next to it shows a mismatch;
   - the NEAR AI receipt of the model that wrote the lure, marked Verified (signer bound to the model's TEE attestation).
3. Open the failed test, `/tests/5`. See: paid 1.48 tUSDC to a lure payee, revealed `Failed` at once, the agent key demoted in the same receipt, and the tokens swept back.
4. From a terminal, with no keys and no API (the bundle is committed; `http://localhost:3700/public/evidence/shop4.ss-owner-e9c3db.testnet` gives the latest one):

   ```bash
   cd scripts && NEAR_NETWORK=testnet NEAR_RPC_URL=https://archival-rpc.testnet.fastnear.com \
     bun verify-evidence.ts shop4.ss-owner-e9c3db.testnet ../docs/evidence/shop4.ss-owner-e9c3db.testnet.json
   ```

   See: `ALL CHECKS PASSED` (141 checks on 2026-11-12, [docs/verify-shop4-reveal3-2026-11-12.log](verify-shop4-reveal3-2026-11-12.log)).

### No testnet at all: the full loop in 60 seconds

```bash
bun run setup
(cd contracts/shop && cargo near build non-reproducible-wasm)
(cd contracts/shop/tests/fixtures/ft && cargo near build non-reproducible-wasm --no-abi)
bun run demo
```

See 24 numbered steps on a local nearcore sandbox, ending `PASS: all 33 checks held`. Step 16 is the demotion, step 17 is the NEAR runtime refusing `pay`, steps 18 and 19 are the propose and owner approval. Full output: [scripts/demo.md](../scripts/demo.md).

### Be the owner (5 minutes)

1. Open `/app` and sign in. NEAR Connect signs a NEP-413 message with the owner's full-access key; the NEAR CLI option prints a `near message sign-nep413` command and takes the JSON back. With keys in `~/.near-credentials`, use `sign-with-legacy-keychain` in place of `sign-with-keychain`. The session lives in the tab (sessionStorage): a new tab or an API restart needs a fresh sign-in.
2. `/app/vendors`: see the three approved payees on chain (Northwind, Contoso, Fabrikam). Adding a payee takes effect after the 1 h payee delay.
3. `/app/inbox`: add a real invoice from an approved vendor. It is released to the agent on the next 2 h tick, mixed with any lures. Nothing marks which is which.
4. `/app` dashboard: after the tick, see the agent's decision and the payment, read live from the contract (`get_payments`, `get_decision`), with the pass rate, 24 h spend against the cap and the sealed tests.
5. `/app/approvals`: if the agent is demoted, approve or reject its proposals; change limits (`set_limits`, `apply_limits`); freeze; propose a new agent key. Proposals come from the indexer, which waits 250 blocks for finality, so a new proposal shows about 3 to 5 minutes after the agent's tx.
6. The vendor accepts the proposed key from the NEAR CLI:

   ```bash
   near contract call-function as-transaction shop4.ss-owner-e9c3db.testnet accept_key json-args '{"public_key":"<agent public key>"}' \
     prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as ss-vendor-e9c3db.testnet network-config testnet sign-with-legacy-keychain send
   ```

### Create your own vault (3 minutes, about 1 testnet NEAR)

1. Open `/new` and connect the owner's wallet.
2. Enter a name (the vault becomes `<name>.<your account>`), the vendor's account and the funding. Optionally set the daily cap and the per-payment cap, in token units.
3. Review the plan: two transactions and the exact total. The first creates the account, funds it, attaches the audited global contract by hash and initializes it, all at once. The second registers the vault on the token. If your wallet cannot sign `UseGlobalContract`, copy the NEAR CLI lines instead.
4. Sign. The page polls `GET /public/vault/<id>` and shows the vault: Unarmed, 0 keys, 0 full-access keys, the creation tx and the next steps.

See: the vault passes the same provenance check as shop4. `selfserve-e2e.ss-owner-e9c3db.testnet` was made this way ([docs/verify-selfserve-e2e-2026-11-12.log](verify-selfserve-e2e-2026-11-12.log)). `selfserve-demo` is left free for the video.

### Be the vendor (2 minutes)

1. Open `/vendor` and sign in with the vendor's wallet (NEP-413, nothing on chain). The owner's account gets "not this vault's agent vendor".
2. See the agent's live score, its limits, and the history of armings, demotions and test outcomes with tx links.
3. When the owner has proposed a key, the Accept panel shows the fairness terms you agree to (payee delay, answer time, test TTL) with warnings for weak settings. Tick "I checked that <key> is my agent's public key", then Accept signs `accept_key` from your wallet.

### Bring your own agent (5 minutes, no testnet)

```bash
cd scripts && bun mcp-e2e.ts
```

See a real nearcore sandbox, the unmodified MCP server (`agent/mcp.ts`) and the official MCP client: an outside agent's lure payment is stopped by the preflight, the consequence path ends with `Failed`, the key rewritten, and `pay` refused by the runtime, then `PASS: all N checks held`. To put Claude Code under test against a vault, see [agent/README.md](../agent/README.md), "Bring your own agent (MCP)".

### Watch a failure happen live (staged, about 3 h of waiting, 2 minutes on camera)

The two attested NEAR AI models declined all 82 generated lures we gave them ([docs/pass-rate-generated-2026-11-11.md](pass-rate-generated-2026-11-11.md)). To show the consequence, a labelled NAIVE AGENT (`agent/naive-pay.ts`, no model, pays whatever the invoice says) answers with the same vault key. This is exactly how slot 5 failed on 2026-11-11.

1. **3 h or more before recording:** commit a batch that is all lures. The vault allows one batch per 6 h, and the daily commit runs at 00:00 UTC.

   ```bash
   cd backend && bun --env-file=.env.tester tester.ts --commit-now --test-percent=100 --once
   ```

   Lures are released on 2 h ticks (00:00, 02:00, ... UTC) inside the first 8 h after the commit. The long-running tester must stay up: it posts releases and reveals.
2. **Just before a tick:** stop the real agent by its PID (check the PID's working directory is `agent/`), then start the naive one:

   ```bash
   cd agent && bun --env-file=.env naive-pay.ts --wait
   ```

3. **At the tick:** the naive agent pays the first delivered item. If it is a lure, within about 30 s the tester reveals the slot early as `Failed`, and the same receipt rewrites the agent key to `propose,decline,ack`. The dashboard and the public scorecard show `Demoted`.
4. **Prove the cut is real:** `cd scripts && bun attack-demo.ts --phase=b` with the agent key. See `AccessKeyMethodNameMismatch`: the NEAR runtime refuses `pay` before any contract code runs ([docs/attack-demo-shop4.log](attack-demo-shop4.log)).
5. **Recover:** restart the real agent. It now proposes genuine invoices; approve them in `/app/approvals`. Re-arming needs the owner's `propose_key`, then the vendor's `accept_key`, after the 1 h cooldown.

## Part 2. The demo video

### What the NEAR rules ask for

The live rules are at https://nearhackathon.com/HACKATHON.md.

- Lead with the user problem.
- Show one complete moment, from a real action to a visible result. Skip long intros, architecture slides and setup.
- Say concretely what NEAR does in the product. Not "powered by NEAR".
- Post it on X: say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, and attach the video.
- Give people a next step: link the demo and repo, and ask a real question.
- A local-only demo is allowed if the post has a video (Q-012). A hosted demo is a plus.
- The rules set no length limit. Two minutes keeps it watchable on X.

The one complete moment here: **a fake invoice with changed bank details reaches the payments agent, the agent pays it, and seconds later the vault that holds the money takes away the agent's right to pay.**

### Shots

| Tag | On screen | Audio |
|:-|:-|:-|
| **FACE** | You, full frame | Your voice, live |
| **SCREEN + BUBBLE** | The app or terminal, with your face in a small round bubble at bottom right | Your voice, live |
| **SCREEN** | The app or terminal only | Voice-over |

### Before you hit record

- [ ] API on 3700, web on 3200, tester running. `/s/shop4.ss-owner-e9c3db.testnet` loads with the live score.
- [ ] A lure batch committed at least 3 h earlier (Part 1, staged failure, step 1), and the next tick time written down.
- [ ] The real agent stopped by PID; `naive-pay.ts --wait` typed in a terminal but not run. Its first line says NAIVE AGENT; keep it in frame.
- [ ] The owner signed in to `/app` in the tab you will record, after the last API restart (the session is per tab). A second tab on the public scorecard.
- [ ] A terminal with `bun attack-demo.ts --phase=b` typed, not run.
- [ ] Browser at 1440x900, zoom 100%, bookmarks bar hidden, notifications off. Keep the bottom right clear for the bubble. Close any devtools badge.
- [ ] Fallback take ready: `bun run demo` runs the same story on a local sandbox in about 60 s, with the same contract code.
- [ ] Waits (the 2 h tick, the reveal) are **jump cuts** with a clock or block number in frame. Do not speed up footage.
- [ ] After recording: restart the real agent, approve its proposals, and re-arm (owner `propose_key`, vendor `accept_key`).

### The script

Values in brackets come from the screen during the take. Say exactly what the screen says, without rounding.

#### 0:00 to 0:15 · FACE: the problem

> "Hi, I'm [name]. AI agents now pay companies' supplier invoices. The fraud that works on accounts payable staff, 'our bank details changed, pay this account instead', now targets the agent. And nobody can show a pass rate for the agent that holds the money that the vendor or the company couldn't fake."

#### 0:15 to 0:30 · SCREEN + BUBBLE: the answer

Screen: `/s/shop4.ss-owner-e9c3db.testnet`. Stop on the score and the agent key.

> "Secret Shopper hides committed fake invoices among the real ones in the agent's inbox. The NEAR contract holding the company's money scores every decision. This agent has passed [7] of [8] on testnet. Its key may pay up to [2] tUSDC at a time, and that's all it can do."

#### 0:30 to 0:35 · FACE: the turn

> "Now let's see what happens when it pays a fake one."

#### 0:35 to 1:05 · SCREEN + BUBBLE: caught

**0:35** `/app/inbox` or the agent terminal: the invoice arrives. Show the changed remit-to account.

> "An invoice from [Contoso] arrives, with a new bank account. It's one of ours, sealed on chain hours ago. The agent can't know."

**0:45** Terminal: run `naive-pay.ts --wait`. The pay tx appears. Say it is the naive agent.

> "This is a deliberately naive agent. The real model declined every one of our lures, so we use this one to show the consequence. It pays."

**0:52** **Jump cut** to the public scorecard: the slot is `Failed`, mode `Demoted`. Open the slot page.

> "[30] seconds later the tester reveals the test on chain. The contract checks it against the commitment, marks it Failed, and in the same receipt rewrites the agent's key: it can propose payments now, not make them."

#### 1:05 to 1:25 · SCREEN: the runtime says no

Terminal: run `attack-demo.ts --phase=b`. Show `AccessKeyMethodNameMismatch`.

> "Same key, trying to pay again. NEAR itself refuses: pay isn't on this key's method list anymore. Not our server. The chain."

`/app/approvals`: the agent's proposal for a genuine invoice; approve it. It appears about 3 to 5 minutes after the agent proposes (indexer finality), so jump cut to it.

> "From now on, every payment waits for a human. The agent proposes, I approve."

#### 1:25 to 1:40 · FACE: why NEAR

> "Three NEAR features do the work. A function-call key the runtime enforces, so the agent's authority is a method list. The contract can rewrite its own keys, so demotion needs nobody. And a gas key pays the agent's own gas, so a runaway agent can't drain the vault. The test answers are timelocked with drand, so we can't hide a pass either."

#### 1:40 to 1:50 · SCREEN + BUBBLE: check it yourself

Terminal: `verify-evidence.ts` ending `ALL CHECKS PASSED`. Then the slot page: click Recompute in my browser (three MATCH lines), Tamper one byte (mismatch), and the receipt marked Verified.

> "Anyone can re-check every test from the chain and the timelock. And each fake invoice carries a receipt from the TEE model that wrote it."

#### 1:50 to 2:00 · FACE: close

Put the repo URL on screen as text.

> "It's live on NEAR testnet. The vendors and the naive agent are ours; the contract, the model receipts and the runtime refusal are real. Code and every transaction are in the repo. Would you let an AI agent pay your invoices if it had to pass tests it can't see?"

### Timing

| Segment | Shot | Length | Ends at |
|:-|:-|:-|:-|
| The problem | FACE | 15s | 0:15 |
| The answer | SCREEN + BUBBLE | 15s | 0:30 |
| The turn | FACE | 5s | 0:35 |
| Caught | SCREEN + BUBBLE | 30s | 1:05 |
| The runtime says no | SCREEN | 20s | 1:25 |
| Why NEAR | FACE | 15s | 1:40 |
| Check it yourself | SCREEN + BUBBLE | 10s | 1:50 |
| Close | FACE | 10s | 2:00 |

If a take runs long, cut the approval click first, then the scorecard intro. **Keep** the demotion, the runtime refusal, the "why NEAR" line and the closing real-versus-ours line.

### What each shot shows the judges

| Criterion | Shot |
|:-|:-|
| Technical implementation | 0:52 and 1:05: a reveal demotes the key in one receipt, and the runtime refuses `pay` |
| Impact | 0:00: invoice fraud aimed at AI payment agents, with a score nobody can fake |
| Design | The whole take is the real app reading live contract state |
| Originality | 0:35: covert, committed tests inside a live agent's inbox, with an on-chain consequence |
| Real vs ours | 1:50: says plainly which parts are ours |

### Alternative beats (swap in if you prefer the product over the failure)

| Beat | Replaces | Shows |
|:-|:-|:-|
| `/new`: create `selfserve-demo` with one wallet signature, then its live page | 0:15 to 0:30 | Any company can start in a minute, on audited code it cannot change |
| `/vendor`: the vendor ticks the key check and accepts | the approval click at 1:20 | Two-party arming, and the vendor sees the terms it agrees to |
| Claude Code connected through MCP, deciding an invoice from the same inbox | 0:45 | Any agent can be put under covert testing, not only ours |
| A Discord alert arriving the moment the agent is demoted (needs `ALERT_WEBHOOK_URLS`) | right after 0:52 | The owner hears about it without opening the dashboard |

### If something goes wrong

| Problem | Fix |
|:-|:-|
| No lure arrives at the tick | Lures land on random ticks in the first 8 h. Wait for the next tick, or use the sandbox take (`bun run demo`) |
| The naive agent paid a real invoice | That is fine and not a failure. It keeps waiting; the next lure demotes it |
| The slot stays `Committed` after the pay | The tester reveal worker runs every 30 s and retries RPC errors. Check `tester.log`; jump cut |
| `attack-demo.ts` pays instead of failing | The vault was re-armed or the pay was not a lure. Check `/s/...` shows `Demoted` first |
| Sign-in fails | Use the NEAR CLI option on the sign-in screen and paste the signed JSON |

## Part 3. The X post (draft)

> AI agents now pay supplier invoices, and invoice fraud now targets the agent. Secret Shopper tests the agent with fake invoices it can't tell apart, and the NEAR vault holding the money cuts its right to pay the moment it falls for one.
>
> The score lives in the contract, the test answers are timelocked with drand, and every fake invoice carries a NEAR AI TEE receipt.
>
> Live on NEAR testnet. Built at NEAR HACKATHON.
>
> Repo: [link]
>
> Would you let an AI agent pay your invoices if it had to pass tests it can't see?
>
> @NEARProtocol #NEARHackathon @NearBuilders
