# 19 Secret Shopper on NEAR testnet (2026-10-31)

Decision: build and run everything on NEAR testnet first; a small mainnet evidence run may follow. Rules allow it: HACKATHON.md Q-010 "Testnet-only projects eligible? Yes, all tracks. Mainnet only where the integration is mainnet-only"; Q-008 "Testnet NEAR is free (near-cli faucet, near-faucet.io)"; Q-007 "Testnet for Intents? None exists or is planned" (live https://nearhackathon.com/HACKATHON.md, fetched today).

Method: live JSON-RPC on four testnet endpoints, FastNEAR tx API and neardata on testnet, NearBlocks API, `gh api` and a clone of near-cli-rs at `v0.30.1`, npm tarballs (`@circle-fin/usdckit` 0.25.4, `@hot-labs/near-connect` 0.12.0, `near-api-js` 7.4.0), the live near-connect wallet manifest, raw `.md` docs (docs.near.org, docs.fastnear.com, docs.near-intents.org, docs.near.ai). Nothing was signed, spent or created.

Labels: **VERIFIED** = seen in a live response, source or official doc today. **UNVERIFIED** = not settled; the check that settles it is named.

Network caveat for this machine: every `*.circle.com` name resolves to `lamanlabuh.aduankonten.id` (182.23.79.195, 139.255.196.196), even through 1.1.1.1. That is the Indonesian content block page, so DNS is intercepted. Circle pages and `faucet.circle.com` need a VPN from this network.

## 1. Facts

### 1.1 Protocol and runtime

| Fact | Value | Source | Label |
|:-|:-|:-|:-|
| Testnet protocol | `protocol_version` 88, `latest_protocol_version` 88, nearcore **2.14.0-rc.5** (rustc 1.95.0), height about 275,600,213 at 12:41 UTC | `status` on rpc.testnet.fastnear.com, test.rpc.fastnear.com, rpc.testnet.near.org (all identical) | VERIFIED |
| Mainnet protocol (for contrast) | 86 (87 vote Nov 4, 88 vote Nov 6; see 17a §3) | `EXPERIMENTAL_protocol_config` on free.rpc.fastnear.com | VERIFIED |
| rc.5 vs 2.14.0 | rc.5 is `CODE_GREEN_TESTNET`, `PROTOCOL_UPGRADE: FALSE`, only #16587 on top of rc.4. Same protocol 88 as final 2.14.0 | https://github.com/near/nearcore/releases/tag/2.14.0-rc.5 | VERIFIED |
| Gas price | testnet `gas_price` 100,000,000 yocto/gas, same as mainnet | `gas_price` RPC on both | VERIFIED |
| Min gas purchase price | `min_gas_purchase_price` 1,000,000,000 (0.001 NEAR per Tgas) on both networks. An 80 Tgas `pay` reserves about 0.08 NEAR of allowance, same as mainnet | `EXPERIMENTAL_protocol_config.runtime_config` on both | VERIFIED |
| Gas rebate to contracts | testnet `burnt_gas_reward` [0, 1] (0%); mainnet [3, 10] (30%) until 88 lands | runtime_config diff; HSP-027 in 2.14.0-rc.1 notes | VERIFIED |
| Other runtime diffs testnet vs mainnet | testnet enables `universal_accounts`, `sha3_host_fns`, `ml_dsa_verify_host_fn`; `max_state_init_entries` 1500. All AddKey, DeleteKey, FC-key and create_account costs identical | runtime_config diff | VERIFIED |
| FC keys, batched DeleteKey+AddKey on self | No 2.14 change to FC permission checks, AddKey/DeleteKey or batch atomicity (17a §2 read this code at tag 2.14.0, which testnet runs) | 17a §2, §3; 2.14.0-rc.1 notes | VERIFIED (source); runtime run by K1 |
| Empty `method_name` | Rejected at validation (`FunctionCallEmptyMethodName`) on 88 | 2.14.0-rc.1 notes | VERIFIED |
| Unpaginated `view_access_key_list` | Fails above 100 keys. Seen live: `testnet` account returns `TOO_MANY_ACCESS_KEYS`. Vault holds at most 2 keys, so unaffected | live query; 2.14.0 notes | VERIFIED |
| Yield/resume | `yield_timeout_length_in_blocks` 200 on both (not used by Secret Shopper) | runtime_config | VERIFIED |
| Account creation | `min_allowed_top_level_account_length` 65 on both, so `name.testnet` is created through the `testnet` contract (faucet or wallet relayer); sub-accounts by the parent are normal CreateAccount, same as mainnet | runtime_config; live `create_account` txs to `testnet` from `meteor-relay.testnet`, `intear-wallet-relay.testnet` | VERIFIED |

### 1.2 Sandbox representativeness

| Fact | Value | Source | Label |
|:-|:-|:-|:-|
| near-workspaces 0.23.0 sandbox | near-sandbox 0.3.16, default nearcore 2.13.4 = protocol 86 | https://github.com/near/near-sandbox-rs/blob/v0.3.16/src/lib.rs#L28 | VERIFIED |
| near-workspaces 0.24.0 sandbox | near-sandbox 0.4.0, default 2.14.0 = protocol 88 = testnet today | 17a §1 | VERIFIED |
| Version override in 0.23.0 | `pub async fn sandbox_with_version(version: &str)` exists | `workspaces/src/worker/mod.rs` line 57 at tag `near-workspaces-v0.23.0` | VERIFIED (API); UNVERIFIED that a 0.3.x client runs a 2.14.0 binary |
| What differs between a PV86 sandbox and PV88 testnet for the vault | 30% gas rebate credited to the vault on 86 (balance-delta assertions differ), empty method name validation, universal accounts. Key, allowance and batch semantics do not differ | rows above | VERIFIED |

Verdict: 0.23.0 tests stay valid for every vault invariant (keys, allowance, modes, money). They are not exact for NEAR balance deltas. With no mainnet deploy before protocol 88 (about Nov 7), the reason 17a gave for staying on 5.29.1 + 0.23.0 (match mainnet PV86) no longer applies. Recommended: near-sdk 5.30.0 + near-workspaces 0.24.0 + `rust-toolchain.toml` 1.97.1, so sandbox, testnet and post-Nov-7 mainnet all run protocol 88. Fallback if 5.30 fails to compile on day 1: keep 5.29.1 + 0.23.0 and do not assert exact vault NEAR deltas in the sandbox.

### 1.3 USDC on testnet

| Fact | Value | Source | Label |
|:-|:-|:-|:-|
| Circle's NEAR testnet USDC | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` | Circle's own SDK: `@circle-fin/usdckit` 0.25.4, `dist/esm/chains/NEAR_TESTNET.js` (`blockchainId: 'NEAR-TESTNET'`, `USDC.address`). Mainnet entry in the same package is `17208628...a1` | VERIFIED |
| `ft_metadata` | `spec ft-1.0.0`, `name USDC`, `symbol USDC`, `decimals 6` | live `call_function` | VERIFIED |
| `storage_balance_bounds` | min = max = `1250000000000000000000` (0.00125 NEAR), same as mainnet | live | VERIFIED |
| Contract family | Circle FiatToken: wasm has `FiatToken: paused`, `blocklist`, `configure_minter`, `mint`, plus "already registered, refunding the deposit", "is not registered", "attached deposit is less than the minimum storage balance" (same strings 17a found on mainnet) | `view_code` (315,265 bytes) | VERIFIED |
| Same code as mainnet? | No. Testnet code hash `EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z`, mainnet `DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q`. One full-access key on testnet | `view_account`, `view_access_key_list` | VERIFIED |
| Registration of a non-existent implicit id | Works: `a9a3547e...56f2e2` does not exist as an account and has `storage_balance_of` = `{"total":"1250000000000000000000","available":"0"}` | live views; tx `4tg3XxnaTT9VnCGE7vAM77AKocPdYTe5bkP7uPbcwgc4` | VERIFIED |
| `ft_transfer` to a registered non-existent implicit id | Not observed on testnet (the two attempts found failed because the sender had 0 balance: "The account doesn't have enough balance") | txs `FhrxYu9b...`, `HW9iTeRY...` | UNVERIFIED (testnet K2) |
| Faucet | Third-party summaries say faucet.circle.com covers NEAR testnet with 20 USDC per 2 h per address. On chain, account `fef9bcbd005d935e16a65db8e8e9ee45b090f126c41755df4a89317d2ebae03d` holds 2,192,764,200 testnet USDC and sends 20 USDC drips (`20000000`), calling `storage_deposit` for new recipients first. That pattern fits the faucet | WebSearch summary; FastNEAR tx API (last 200 txs to the token) | UNVERIFIED (Circle docs unreachable from this network; human claims once through a VPN) |
| Other "USDC" on testnet | `usdc.fakes.testnet` (now `Bridged USDC`, `USDC.e`, 6 dp; near-faucet.io's backing contract `v2.faucet.nonofficial.testnet` lists it, 100 per request) and `usdc.testnet` (`USDC`, no icon, 3 full-access keys). Neither is Circle's | live `ft_metadata`, `ft_list_tokens` | VERIFIED |
| Own test token option | `examples/fungible-token/ft` at `near-sdk-v5.29.1` exposes `new(owner_id, total_supply, metadata)`, so symbol and decimals can be set (`tUSDC`, 6) | https://github.com/near/near-sdk-rs/tree/near-sdk-v5.29.1/examples/fungible-token | VERIFIED |

Circle testnet USDC vs our own tUSDC:

| | Circle testnet USDC (`3e2210e1...`) | Own `tUSDC` from near-sdk example |
|:-|:-|:-|
| Honesty | Issuer's official test token; README can say "Circle USDC (testnet)" and cite Circle's SDK | Must be labelled "test token we deployed"; judges see a self-minted token |
| Fidelity to mainnet | Same FiatToken family: pause, blocklist and NEP-145 refund paths match mainnet. Code hash differs, so K2 still reruns on mainnet | near-contract-standards only; no pause or blocklist; refund behaviour from standards source |
| Supply | 20 USDC per 2 h per address (unverified); tests pay 0.01 USDC, so one claim covers hundreds of payments | Unlimited |
| Dependencies | Circle can pause or upgrade (one full-access key); faucet needs a browser and a VPN here | None |
| Judging | Stronger: "runs on Circle's testnet USDC" is real-world grade and matches the user rule against mock data | Acceptable for the local `bun run demo` (already a vendored FT fixture); weaker for the hosted demo |

Recommendation: use Circle testnet USDC for the hosted testnet vault and every README tx link. Keep the vendored FT fixture for sandbox and `bun run demo`, named `tUSDC` with name "Test USDC (sandbox only)". Deploy tUSDC to testnet only if the Circle faucet cannot be reached by Nov 2.

### 1.4 Intents

| Fact | Value | Source | Label |
|:-|:-|:-|:-|
| Intents testnet | "There is no testnet deployment and no plans for one" | https://docs.near-intents.org/resources/faqs ; also /integration/verifier-contract/introduction and the 1Click quickstart | VERIFIED |
| `intents.near` on testnet | `UNKNOWN_ACCOUNT` | `view_account` | VERIFIED |
| `intents.testnet` | Exists, **no contract** (code hash `1111...`), 0 NEAR, one full-access and one FC key held by an unknown party. `defuse.testnet` likewise has no contract | `view_account`, `view_access_key_list` | VERIFIED |

Consequence: on testnet the Intents rail must be disabled in the contract, not pointed at a placeholder. Pointing `intents_id` at `intents.testnet` would send USDC via `ft_transfer_call` to an account a stranger controls and could later deploy code to.

### 1.5 CLI and faucets

| Fact | Value | Source | Label |
|:-|:-|:-|:-|
| near-cli-rs latest stable | 0.30.1 (npm `latest`, crates.io `max_stable_version`); 0.31.0-rc.2 exists (Oct 19) | registry.npmjs.org/near-cli-rs; crates.io API | VERIFIED |
| `create-account sponsor-by-faucet-service <id>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create` | Exact form, "testnet only for now" | `docs/GUIDE.en.md` lines 646 to 667 at v0.30.1 | VERIFIED |
| Sub-account | `create-account fund-myself <sub> '<amount> NEAR' autogenerate-new-keypair save-to-keychain sign-as <parent> network-config testnet sign-with-keychain send`; `sign-as` takes a positional `signer_account_id` | GUIDE line 795; `fund_myself_create_account/sign_as/mod.rs` line 10 | VERIFIED |
| Deploy with init | `contract deploy <id> use-file <wasm> with-init-call <method> json-args '<json>' prepaid-gas '100 TGas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`; modes `use-file`, `use-global-hash`, `use-global-account-id` | GUIDE line 2440; `src/commands/contract/deploy/mod.rs` | VERIFIED |
| Delete keys | `account delete-keys <id> public-keys <ed25519:...> network-config testnet sign-with-keychain send` | GUIDE line 1473 | VERIFIED |
| List keys | `account list-keys <id> network-config testnet now` | GUIDE line 1210 | VERIFIED |
| FC key | `account add-key <id> grant-function-call-access` with long options allowance, contract account id, function names; then `use-manually-provided-public-key <pk>`. Allowance accepts `unlimited` (never use it). Omitted values are prompted interactively. The same menu also offers `grant-gas-key-function-call`: never pick it for agent or tester keys (17a §2) | GUIDE line 1431; `add_key/mod.rs`, `access_key_type/mod.rs`, `types/near_allowance.rs` | VERIFIED |
| `tokens <signer> send-ft <ft> <receiver> '<n> USDC' memo ''` | Adds `storage_deposit` automatically when the receiver is unregistered (`storage_balance_of` check, then `[storage_deposit, ft_transfer]`) | GUIDE line 1690; `src/commands/tokens/send_ft/mod.rs` lines 211 to 234 | VERIFIED |
| Deposit unit | `'1 yoctoNEAR'` is accepted | GUIDE lines 1650, 1738 | VERIFIED |
| CLI testnet defaults | RPC `archival-rpc.testnet.fastnear.com`, faucet `https://helper.nearprotocol.com/account`, linkdrop account `testnet`, explorer link `explorer.testnet.near.org` | `src/config/mod.rs` lines 94 to 109 | VERIFIED |
| Faucet funding amount | `near-contract-helper` deploy config sets `NEW_ACCOUNT_AMOUNT` 10.000001 NEAR | https://github.com/near/near-contract-helper/blob/master/ecs/contract-helper.task-definition.json | UNVERIFIED (live amount; check with `view-account-summary` after creation) |
| Faucet limits | Not published for the helper. Docs faucet API gives **5 NEAR** per POST to `https://docs-mcp-f18b.onrender.com/api/faucet` with `{"accountId": "..."}`, no key; near-faucet.io gives NEAR and `*.fakes.testnet` tokens | https://docs.near.org/getting-started/faucet.md | VERIFIED (docs); rate limits UNVERIFIED |

### 1.6 Indexing and explorers

| Fact | Value | Source | Label |
|:-|:-|:-|:-|
| FastNEAR tx API testnet | `https://tx.test.fastnear.com`. `POST /v0/account` returned 200 with `{account_txs, resume_token, txs_count}` (96,034 txs for testnet USDC); `POST /v0/transactions` returned `transactions[]` with `transaction, execution_outcome, receipts[], data_receipts`, each receipt `{execution_outcome: {block_hash, block_height, block_timestamp, id, index, outcome}, receipt}`. Same shape as mainnet (17a §8). `/status` lag 3 s. No key needed today; docs say send a key with every request | live; https://docs.fastnear.com/tx.md lines 16, 34, 36 | VERIFIED |
| neardata testnet | `https://testnet.neardata.xyz/v0/last_block/final` returns 302 to `/v0/block/<h>`; block has 10 shards, `receipt_execution_outcomes[]` with `execution_outcome.outcome.{executor_id, logs, status, ...}`, `receipt.{predecessor_id, receiver_id, receipt_id, receipt}`, `tx_hash`. Same as mainnet | live; https://docs.fastnear.com/neardata.md line 16 | VERIFIED |
| FastNEAR account API testnet | `https://test.api.fastnear.com` (`/status` synced, `/v1/account/<id>/full` works) | live | VERIFIED |
| NearBlocks testnet API | `https://api-testnet.nearblocks.io/v3/...` is current (latest block 275,601,696; `/v1/sync/status` synced). `v3/txns/<hash>` returns the tx; `v3/search/receipts?keyword=<receipt_id>` maps a receipt to its tx hash. **v1 is stale**: `v1/blocks/latest` is block 270,420,307 (Sep 27) and `v1/txns/<hash>` returns empty | live | VERIFIED |
| NearBlocks testnet web | `https://testnet.nearblocks.io/txns/<tx_hash>` is the pattern near-faucet.io links to. Pages return 403 to scripted clients (Cloudflare), so the page itself and `/address/<id>` were not fetched | near-faucet.io bundle; curl and WebFetch both 403 | UNVERIFIED (open one link in a browser) |
| explorer.testnet.near.org | An "Explorer Selector" page (`NEXT_PUBLIC_ACCOUNT_ID: nearblocks.testnet`) that sends users to an explorer; near-cli-rs prints these links by default | live `__ENV.js` | VERIFIED |

### 1.7 Wallets (near-connect 0.12.0)

| Fact | Value | Source | Label |
|:-|:-|:-|:-|
| Network option | `new NearConnector({ network: 'testnet', providers: { testnet: [...] }, features })`; default `mainnet`; `switchNetwork(network)` disconnects and reconnects | `build/NearConnector.js` lines 37 to 54, 143 to 149; `NearConnector.d.ts` lines 7, 14 | VERIFIED |
| Testnet filter | `availableWallets` drops any wallet whose manifest lacks `features.testnet` when `network === 'testnet'` | `build/NearConnector.js` lines 122 to 125 | VERIFIED |
| Per-call network | Sandboxed wallets receive `network: params.network ?? connector.network` on sign-in, `signMessage` and `signAndSendTransaction`; `providers` is passed into the wallet sandbox | `build/SandboxedWallet/index.js` lines 21 to 67; `code.js` lines 189 to 191 | VERIFIED |
| Wallets shown on testnet (live manifest v1.1.0, last commit 2026-10-27) | **meteor-wallet**, **intear-wallet**, **near-cli**, ledger, nightly-wallet, unity-wallet, wallet-connect (needs a `walletConnect` option), ethereum-wallets (no `signMessage`) | https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json | VERIFIED |
| Wallets hidden on testnet | **hot-wallet, mynearwallet**, okx-wallet, near-mobile, hana-wallet, trezu-wallet (no `testnet` feature). Sender is not in the manifest (could only appear through the `near-wallet-injected` event) | same manifest; `NearConnector.js` line 89 | VERIFIED |
| NEP-413 on testnet | Meteor, Intear, near-cli, Ledger, Nightly, Unity declare `signMessage: true` and `testnet: true`. README recipe: `features: { signMessage: true, testnet: true }` | manifest; package README line 186 | VERIFIED (flags); UNVERIFIED (each wallet's actual testnet signMessage, click test on day 1) |

### 1.8 NEAR AI, near-api-js, RPC limits

| Fact | Value | Source | Label |
|:-|:-|:-|:-|
| NEAR AI Cloud network coupling | None for inference: HTTPS API at `cloud-api.near.ai` with an API key (200 today). Only "Staking for Inference" is a NEAR mainnet payment path; card or crypto top-up is the other | https://docs.near.ai/llms-full.txt (Staking for Inference, Add Credits) | VERIFIED |
| $10 credit | HACKATHON.md Q-000: "claim $10 by joining NEAR Builders (https://nearbuilders.org/join)". The join page is client-rendered (GitHub and Google login, Sign-in-with-NEAR on mainnet recipient `dev.everything.near`); it does not state the credit itself in server HTML | live HACKATHON.md line 62; nearbuilders.org/join `__RUNTIME_CONFIG__` | VERIFIED (rule); UNVERIFIED (claim flow) |
| near-api-js 7.4.0 testnet | Network is only the RPC URL: `new JsonRpcProvider({ url })` (`ConnectionInfo { url, headers? }`); no `testnet` literal anywhere in `lib/*.js`. `new Account(id, provider, keyPairString)`, `keyToImplicitAddress(pk)`, `KeyPair.fromRandom('ed25519')` | `lib/index.d.ts` lines 1376, 1411; `key_pair-*.d.ts` line 19; 17a §5 | VERIFIED |
| RPC free tiers | FastNEAR `test.rpc.fastnear.com`: free, limit "Not published". `archival-rpc.testnet.near.org`: "Severely rate limited". dRPC `near-testnet.drpc.org`: about 2,100 CU/s. Intear `testnet-rpc.intea.rs`: not published. No rate-limit headers returned. Docs: "Never load test a shared public endpoint" | https://docs.near.org/api/rpc/providers.md lines 39 to 57, 75; live `status` on all four (PV 88, same height) | VERIFIED |

## 2. Testnet runbook

Placeholders the human fills: `<owner>`, `<vendor>`, `<OWNER_FAK_OF_VAULT>`, `<TESTER_PK>`, `<AGENT_PK>`. Run from the repo root. Every command is near-cli-rs 0.30.1.

```bash
# 0. Tools
npm install -g near-cli-rs@0.30.1
near

# 1. Owner and vendor accounts (faucet pays creation; keys go to the OS keychain)
near account create-account sponsor-by-faucet-service <owner>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service <vendor>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account view-account-summary <owner>.testnet network-config testnet now

# 1b. Optional top-up, 5 NEAR per request (docs faucet API)
curl -X POST https://docs-mcp-f18b.onrender.com/api/faucet -H 'Content-Type: application/json' -d '{"accountId":"<owner>.testnet"}'

# 2. Testnet USDC: open https://faucet.circle.com in a browser (VPN on this network), pick NEAR testnet, paste <owner>.testnet, claim. Then check:
near contract call-function as-read-only 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af ft_balance_of json-args '{"account_id":"<owner>.testnet"}' network-config testnet now

# 3. Vault sub-account with a temporary full-access key
near account create-account fund-myself shop.<owner>.testnet '3 NEAR' autogenerate-new-keypair save-to-keychain sign-as <owner>.testnet network-config testnet sign-with-keychain send

# 4. Build and deploy with init (init args per contracts/shop: token_id, and intents_id null disables the rail on testnet, see §4)
cargo near build non-reproducible-wasm
near contract deploy shop.<owner>.testnet use-file target/near/secret_shopper.wasm with-init-call new json-args '{"owner_id":"<owner>.testnet","vendor_id":"<vendor>.testnet","token_id":"3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af","intents_id":null,"policy":{"daily_cap":"5000000","max_per_payment":"2000000","max_new_payees_per_day":5,"batch_size":3,"batch_interval":"86400000000000","test_ttl":"172800000000000","reveal_grace":"86400000000000","rearm_cooldown":"3600000000000","key_allowance":"1000000000000000000000000","storage_deposit":"1250000000000000000000"}}' prepaid-gas '100 TGas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# 5. Fund the vault with USDC (send-ft registers the vault on USDC first if needed)
near tokens <owner>.testnet send-ft 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af shop.<owner>.testnet '5 USDC' memo '' network-config testnet sign-with-keychain send

# 6. LOCK: find the vault's full-access key, delete it, confirm no keys remain
near account list-keys shop.<owner>.testnet network-config testnet now
near account delete-keys shop.<owner>.testnet public-keys <OWNER_FAK_OF_VAULT> network-config testnet sign-with-keychain send
near account list-keys shop.<owner>.testnet network-config testnet now

# 7. Tester key: FC key on <owner>.testnet scoped to the vault. Generate the pair locally first:
bun -e "import { KeyPair } from 'near-api-js'; const k = KeyPair.fromRandom('ed25519'); console.log(k.getPublicKey().toString()); console.error(k.toString())" 2>> backend/.env.tester.secret
near account add-key <owner>.testnet grant-function-call-access
#   prompts: allowance '0.5 NEAR'; contract account id shop.<owner>.testnet; function names commit_batch, reveal
#   then: use-manually-provided-public-key <TESTER_PK>, network-config testnet, sign-with-keychain, send
#   never choose grant-gas-key-function-call
near account list-keys <owner>.testnet network-config testnet now

# 8. Arm the agent: vendor generates <AGENT_PK> the same way, owner proposes, vendor accepts (1 yocto each)
near contract call-function as-transaction shop.<owner>.testnet propose_key json-args '{"public_key":"<AGENT_PK>"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <owner>.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction shop.<owner>.testnet accept_key json-args '{"public_key":"<AGENT_PK>"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <vendor>.testnet network-config testnet sign-with-keychain send
near account list-keys shop.<owner>.testnet network-config testnet now
near contract call-function as-read-only shop.<owner>.testnet get_status json-args '{}' network-config testnet now
```

Notes:
- Step 7 writes the private key to an untracked file through stderr; add `backend/.env.tester.secret` to `.gitignore` before running it. Move the value into `TESTER_PRIVATE_KEY` and delete the file.
- `accept_key` gas: 30 Tgas is a placeholder until K1 measures it; the 16b spec does not size it.
- Expected after step 8: the vault lists exactly one FC key (`<AGENT_PK>`, receiver the vault, methods `pay, decline`), no full-access key. This is the "Locked vault" README claim.
- K2 on testnet now costs nothing: run `scripts/k2-mainnet-pay.ts` with the testnet RPC and USDC id (rename it `k2-pay.ts`). It settles the one UNVERIFIED USDC row.

## 3. Env values for testnet

`backend/.env`
```
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.fastnear.com
NEAR_RPC_URLS=https://rpc.testnet.fastnear.com,https://test.rpc.fastnear.com,https://testnet-rpc.intea.rs,https://near-testnet.drpc.org
NEARDATA_URL=https://testnet.neardata.xyz
NEAR_TX_API_URL=https://tx.test.fastnear.com
NEAR_CONTRACT_ID=shop.<owner>.testnet
SHOP_CONTRACT_ID=shop.<owner>.testnet
USDC_CONTRACT_ID=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
INTENTS_CONTRACT_ID=
EXPLORER_URL=https://testnet.nearblocks.io
NEARBLOCKS_API_URL=https://api-testnet.nearblocks.io/v3
FASTNEAR_API_KEY=<optional, backend only>
```
`backend/.env.tester`: same `SHOP_CONTRACT_ID`, `USDC_CONTRACT_ID`, `NEAR_RPC_URL`; `TESTER_ACCOUNT_ID=<owner>.testnet`; `SWEEP_FUNDER_ID=sweeper.<owner>.testnet`. NEAR AI values unchanged.

`agent/.env`: `AGENT_VAULT_ID=shop.<owner>.testnet`, `NEAR_RPC_URL=https://rpc.testnet.fastnear.com`. NEAR AI values unchanged.

`web/.env`
```
VITE_NEAR_NETWORK=testnet
VITE_NEAR_CONTRACT_ID=shop.<owner>.testnet
VITE_USDC_CONTRACT_ID=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
VITE_INTENTS_CONTRACT_ID=
```
Explorer links: tx `https://testnet.nearblocks.io/txns/<tx_hash>`, account `https://testnet.nearblocks.io/address/<id>` (pattern UNVERIFIED, browser check).

## 4. Changes needed vs the mainnet spec (16b, 14, 18)

1. **Contract: `intents_id: Option<AccountId>`.** `None` disables the rail. `pay` and `propose` panic with "intents rail disabled" when `rail == Intents` and `intents_id` is `None`, before any state change. Immutable after init. Add `intents_enabled: bool` to `get_policy` or `get_status`. New sandbox test: Intents rail rejected when `None`; accepted path unchanged when `Some`. Do not point the field at `intents.testnet` (third-party account, no contract).
2. **Agent tool schema:** build the `rail` enum from `intents_enabled` (testnet offers only `Near`). Tester never generates Intents payees on testnet.
3. **Version pairing:** move to near-sdk 5.30.0 + near-workspaces 0.24.0 + toolchain 1.97.1 so the sandbox runs protocol 88 like testnet (§1.2). Fallback stated there.
4. **Config defaults:** 16b §6.2 defaults `NEAR_RPC_URL` and `NEARDATA_URL` to mainnet and hardcodes the mainnet USDC id. Derive all three from `NEAR_NETWORK` like 14 §3.1 already does for `NEAR_TX_API_URL`; require `USDC_CONTRACT_ID` explicitly.
5. **Explorer links:** use the tx hash, not the receipt id (16b §6.4 assumed NearBlocks resolves receipts on the web). The FastNEAR rows already carry `transaction.hash`. If only a receipt id is known, resolve via `api-testnet.nearblocks.io/v3/search/receipts?keyword=<id>`. Never call NearBlocks `v1` on testnet (stale).
6. **Web wallet:** `new NearConnector({ network: 'testnet', features: { signMessage: true, testnet: true }, providers: { testnet: ['https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com'] } })`. Copy for testnet: "Use Meteor or Intear wallet (HOT and MyNearWallet do not support testnet here)". The `near-cli` connector also works for the team.
7. **NEP-413:** the backend `verifyMessage` provider must be the testnet provider; `AUTH_RECIPIENT` unchanged.
8. **K2, K5, K7 move to testnet** (free). K6 (Intents) stays mainnet only and is optional.
9. **Hosted scorecard:** read views through the backend `/public` route with a short cache and a `FailoverRpcProvider` over the four testnet RPCs in §3, not straight from every browser, because no free tier publishes a limit. Keep any FastNEAR key server side.
10. **README:** state "Runs on NEAR testnet, protocol 88, with Circle's testnet USDC `3e2210e1...`", link Circle's usdckit as the source of the address, and add the limitation "Intents rail disabled on testnet; NEAR Intents has no testnet".
11. **Threat model:** testnet USDC is a different build from mainnet (code hash differs); behaviour checks done on testnet are evidence for the design, not for the mainnet token.

## 5. Mainnet later: delta list

| Item | Testnet | Mainnet |
|:-|:-|:-|
| USDC | `3e2210e1...cb8af` | `17208628...36133a1` (re-run K2: different code hash) |
| Intents rail | `intents_id: null` | `intents_id: "intents.near"`; run K6 |
| Protocol | 88 now | 86 until about Nov 5 (87) and Nov 7 (88). A 5.30.0 build carries `min_protocol_version` 88: check `status` shows 88 before deploying |
| Gas rebate | 0% | 30% until 88 lands; affects only NEAR balance deltas |
| Accounts | Faucet-sponsored `.testnet` | Funded `.near` via `fund-myself`; no faucet |
| RPC | `rpc.testnet.fastnear.com`, `test.rpc.fastnear.com` | `rpc.mainnet.fastnear.com`, `free.rpc.fastnear.com` |
| Indexers | `tx.test.fastnear.com`, `testnet.neardata.xyz` | `tx.main.fastnear.com`, `mainnet.neardata.xyz` |
| Explorer | `testnet.nearblocks.io`, API `api-testnet.nearblocks.io/v3` | `nearblocks.io`, `api.nearblocks.io` |
| Wallets | Meteor, Intear, near-cli, Ledger, Nightly, Unity | Adds HOT, MyNearWallet, OKX, Near Mobile, Hana |
| Money | Free | About 3 NEAR + 10 USDC (18 §7); sweeps of failed-test implicit payees cost real NEAR; use a fresh vault id, never reuse the testnet name pattern for a vault with funds |
| NEAR AI | Same | Same |
| README | Testnet tx table | Separate mainnet tx table, each link labelled with its network and protocol version |

## 6. Still UNVERIFIED

| Item | Settled by |
|:-|:-|
| faucet.circle.com serves NEAR testnet USDC, amount and cooldown | Human claim through a VPN on Nov 1 |
| `ft_transfer` to a registered, non-existent implicit id on testnet USDC; storage refund on second deposit | K2 on testnet |
| Live faucet funding per `sponsor-by-faucet-service` account | `view-account-summary` after step 1 |
| near-sdk 5.30.0 + workspaces 0.24.0 compile and K1 pass | K1 on Nov 1 |
| Meteor and Intear `signMessage` on testnet produce a signature that `verifyMessage` accepts | Click test with the web app on Nov 1 to 2 |
| NearBlocks testnet web URL patterns `/txns/<hash>` and `/address/<id>` render | Open one link in a browser |
| Rate limits of the free testnet RPCs | Not published; design avoids depending on them (§4 item 9) |

## Sources
- Live JSON-RPC: rpc.testnet.fastnear.com, test.rpc.fastnear.com, rpc.testnet.near.org, archival-rpc.testnet.near.org, archival-rpc.testnet.fastnear.com, testnet-rpc.intea.rs, near-testnet.drpc.org, free.rpc.fastnear.com
- https://tx.test.fastnear.com, https://testnet.neardata.xyz, https://test.api.fastnear.com, https://api-testnet.nearblocks.io (v1, v3)
- https://github.com/near/nearcore/releases (2.14.0-rc.1, rc.5, 2.14.0)
- near-cli-rs clone at tag v0.30.1: `docs/GUIDE.en.md`, `src/config/mod.rs`, `src/commands/{account,contract,tokens}`
- https://github.com/near/near-contract-helper (ecs task definition)
- https://github.com/near/near-workspaces-rs tag near-workspaces-v0.23.0; https://github.com/near/near-sandbox-rs v0.3.16
- https://github.com/near/near-sdk-rs/tree/near-sdk-v5.29.1/examples/fungible-token
- npm tarballs: @circle-fin/usdckit 0.25.4, @hot-labs/near-connect 0.12.0, near-api-js 7.4.0
- https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json
- https://docs.near.org/getting-started/faucet.md, https://docs.near.org/api/rpc/providers.md
- https://docs.fastnear.com/tx.md, /neardata.md, /auth.md
- https://docs.near-intents.org/llms-full.txt (faqs, verifier-contract introduction, 1Click quickstart)
- https://docs.near.ai/llms-full.txt; https://cloud-api.near.ai/v1/model/list
- https://nearhackathon.com/HACKATHON.md (Q-000, Q-007, Q-008, Q-010)
- Secondary only: WebSearch summaries of developers.circle.com and faucet.circle.com (domain blocked on this network)
