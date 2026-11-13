<img src="public/logo.svg" width="72" height="72" alt="Secret Shopper logo: a figure carrying a parcel">

# Secret Shopper web app

The public scorecard and the owner app for a Secret Shopper vault. Anyone can check a vault's test results against the chain in their browser; the owner signs in with a NEAR wallet to watch the inbox, approve proposed payments, re-arm the agent and change limits. What the product is: [../README.md](../README.md). How to build and test the whole repo: [../AGENTS.md](../AGENTS.md).

Every number on every page comes from the vault contract (RPC views) or the Secret Shopper API. There is no mock data: pages show real loading, empty and error states.

## Pages

| Route | For | Shows | Reads |
|:-|:-|:-|:-|
| `/` | Visitors | What the product does; a replay of the newest real Failed test; "Spot the fake" with a real revealed lure among labelled examples; live pass rate, model results and test counts | `get_scorecard`, `get_status`, `get_test`, `get_release`, `view_access_key_list`; `GET /public/tests`, `/public/model-runs`, `/public/verify-report` |
| `/s/$shopId` | Anyone | Public scorecard: lure score beside genuine invoices paid, every outcome count, schedule, agent key and vendor, spending against limits, delivery coverage, every test slot, evidence and ledger downloads | `get_scorecard`, `get_status`, `get_policy`, `view_access_key_list`, token metadata; `GET /public/tests/:shopId`, `/public/throughput/:shopId`, `/public/schedule/:shopId`, `/public/evidence/:shopId`, `/public/ledger/:shopId` |
| `/s/$shopId/ledger` | Accountants | Every payment, proposal, decline and test slot from on-chain events, filterable, with tx links and CSV download | `GET /public/ledger/:shopId` |
| `/s/$shopId/tests/$slot` | Anyone | One test: commit, delivery, decision, reveal, demotion and sweep timeline; the email and invoice as the agent saw them; the commitment and NEAR AI receipt recomputed in the browser, with a one-byte tamper button | `get_test`, `get_decision`, `get_release`; `GET /public/tests/:shopId/:slot`, `GET /public/releases/:shopId` |
| `/app` | Owner | Dashboard: pass rate beside genuine invoices paid, schedule, 24 h spend against the cap, payments, sealed tests, agent key, activity, ledger download | `get_scorecard`, `get_status`, `get_policy`, `get_payments`, `view_access_key_list`; `GET /tests`, `/proposals`, `/company/alerts`, `/public/throughput/:shopId` |
| `/app/inbox` | Owner | Every delivered invoice and the agent's decision; add a real invoice in the vendor's own layout | `GET /invoices`, `get_decision`, `GET /company/me`, `GET /vendors`, `POST /invoices` |
| `/app/tests` | Owner | Sealed slots with their timelock countdown, revealed slots with outcomes | `GET /tests` |
| `/app/approvals` | Owner | Pending proposals (amount and payee shown from the chain; Approve is off if the API disagrees), the two-party re-arm flow, limits, freeze | `GET /proposals`, `get_proposals`, `get_status`, `get_policy`, `get_pending_limits`, `get_payees`; signs `approve`, `reject`, `propose_key`, `set_limits`, `apply_limits`, `freeze` |
| `/app/vendors` | Owner | Vendors with their sample invoices; the on-chain approved payee list with add and remove, blocklisted payees marked; report a payee to the shared blocklist | `GET /vendors`, `POST /vendors`, `PUT /vendors/:id`, `POST /blocklist`, `GET /public/blocklist/:id`, `get_payees`; signs `add_payee`, `remove_payee` |
| `/new` | Any company | Create a vault in one wallet transaction from the published code, then finish setup: approve payees, propose the agent key, the vendor's accept command, token funding | `GET /public/vault-template`, `POST /public/vault-plan` (checked in the browser), `GET /public/vault/:id`, `view_account`, `get_status`, `get_payees`, `view_access_key_list`, `ft_balance_of`, `storage_balance_bounds`; signs the plan, `add_payee`, `propose_key`, `ft_transfer` |
| `/vendor` | Agent vendor | Arm the agent (accept the owner's key, after the fairness terms and a key confirmation), vault limits, test record, history | `GET /vendor/me`, `/vendor/history`, `get_status`; signs `accept_key` |
| `/agent/$vendorId` | Anyone | A vendor's track record: every vault it armed, each scorecard, the pooled score and its caveat | `GET /public/agent/:vendorId` |
| `/blocklist` | Anyone | The shared payee blocklist with proof transactions, and a lookup by account | `GET /public/blocklist`, `/public/blocklist/:id` |
| `/agents` | Agent builders | Bring your own agent over MCP: the 7 tools, enforce or advisory preflight, setup for Claude Code and Claude Desktop | None (from `agent/README.md`) |
| `/devices` | Developers, dev builds only | Every page side by side at phone, tablet and desktop widths | Same as the pages it frames |

The owner routes call `GET /company/me` first and show an error if the signed-in account does not own `VITE_SHOP_CONTRACT_ID`.

## Wallet and sign-in

The wallet is [NEAR Connect](https://github.com/azbang/hot-connector) (`@hot-labs/near-connect` 0.12.0), loaded only in the browser (`src/lib/near/wallet.ts`).

Sign-in is NEP-413, with nothing sent on chain:

1. `POST /auth/nonce` returns a message, a recipient and a 32-byte nonce.
2. The wallet signs it with `signMessage`. The API accepts only a full-access key.
3. `POST /auth/verify` returns a JWT valid for 12 hours. It is kept in memory and `sessionStorage`, so it ends with the tab.

Owner actions go through `signAndSendTransaction` to the vault with 1 yoctoNEAR attached. Before the wallet opens, a sheet shows the receiver, method, arguments, deposit and gas. Gas comes from the repo's own scripts: 100 Tgas for `approve` on the NEAR rail, 150 Tgas on the Intents rail, 30 Tgas otherwise (`src/config.ts`).

Wallets with a NEAR CLI option work too. NEAR Connect shows the `near` command to run and asks for its JSON output (sign-in) or the transaction hash (transactions). With keys in `~/.near-credentials`, run the command with `sign-with-legacy-keychain` in place of `sign-with-keychain`.

## What the browser does not take from the API

Everything the owner or vendor signs is built or checked in the browser (audit of 2026-11-13):

- **New vault plans** are checked action by action against the form (`src/lib/vaultPlan.ts`, tested in `vaultPlan.test.ts`): account, funding, the code hash pinned in `VITE_VAULT_CODE_HASH`, owner, vendor, token, no Intents rail, the caps typed, payee and limit delays of at least an hour, key funding of at most 1 NEAR, and a token registration no dearer than the token's `storage_balance_bounds`. The total and the NEAR CLI fallback are computed here.
- **Approvals** show amount and payee from `get_proposals`; Approve is off if the API's copy differs.
- **The vendor's `accept_key`** uses the vault's `pending_key` read from the chain.
- **Sign-in** signs only a challenge for this site's hostname (or `VITE_AUTH_RECIPIENT`) and the expected message.
- **`GET /public/config`** never redirects a production or pinned build.
- **After creation**, owner, vendor, code hash and full-access keys come from `view_account`, `get_status` and `view_access_key_list`.

Onboarding was run on testnet on 2026-11-13 against `selfserve-e2e.ss-owner-e9c3db.testnet`, which is left Unarmed on purpose as a record of the steps: `add_payee` [AHaVUNjs...](https://testnet.nearblocks.io/txns/AHaVUNjshB9rYNV4BwzrRaH8goEBbPw1iimgxANaa51F), `propose_key` of a throwaway key whose private half was never stored [HucuFuoB...](https://testnet.nearblocks.io/txns/HucuFuoByMhD3WKgdt5bKPDZvm3MirJLXAZTWaG5AcM1), and 0.5 tUSDC `ft_transfer` [BPRsWkNP...](https://testnet.nearblocks.io/txns/BPRsWkNPrA1niYhbve3kupynX1V4Yq7dXvmL7i4af61P).

## What the browser verifies

`src/lib/near/proofs.ts` recomputes, with Web Crypto only:

- The test commitment `sha256(salt ‖ len ‖ payee ‖ invoice_id ‖ receipt_hash)`, compared with `get_test.commitment`.
- The invoice id: SHA-256 of the canonical JSON (sorted keys), the same as the API.
- The release Merkle root and each proof, compared with `get_release`.
- The NEAR AI receipt: SHA-256 of the stored request and response, rebuilt into the signed text.
- The agent key scope from `view_access_key_list`. Unknown or malformed permissions fail closed, and only a function-call key on the vault with `pay,decline` or `propose,decline` (plus `ack`) counts as the agent key.

`src/lib/near/proofs.test.ts` checks these against the fixtures that the backend and contract tests also use: `backend/test/fixtures/commitment.json` and `merkle.json`.

## Run locally

Needs Bun and a running API (see [../backend](../backend)).

```bash
cd web
bun install
bun dev          # http://localhost:3200
```

The API's CORS allows `http://localhost:3200` by default, and its `AUTH_RECIPIENT` must equal the web host for sign-in to work.

Environment, read in `src/env.ts` (all optional; `.env.example` is still the starter's and lags this list):

| Variable | Default |
|:-|:-|
| `VITE_API_URL` | `http://127.0.0.1:3700` |
| `VITE_NEAR_NETWORK` | `testnet` (or `mainnet`) |
| `VITE_NEAR_RPC_URLS` | FastNEAR RPCs for the network, comma list tried in order |
| `VITE_SHOP_CONTRACT_ID` | `shop4.ss-owner-e9c3db.testnet` |
| `VITE_EXPLORER_URL` | nearblocks for the network |
| `VITE_READONLY_DEMO` | unset. `true` on a hosted demo whose API serves public routes only: `/app` and `/vendor` then show a read-only notice instead of sign-in |
| `VITE_DEFAULT_TOKEN_ID` | `tusdc.ss-owner-e9c3db.testnet`; the token a new vault pays in when the field is left empty |
| `VITE_VAULT_CODE_HASH` | `5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs`, the audited 2.3.0 build; new vault plans must use it |
| `VITE_AUTH_RECIPIENT` | this page's hostname; must equal the API's `AUTH_RECIPIENT` |
| `VITE_REPO_URL` | unset; when set (https), footer evidence files link to it |

Checks, run on 2026-11-13:

```bash
bun run test
```
```
 ✓ src/lib/csv.test.ts (2 tests)
 ✓ src/lib/invoice.test.ts (5 tests)
 ✓ src/utils/near.test.ts (2 tests)
 ✓ src/lib/vaultPlan.test.ts (5 tests)
 ✓ src/lib/near/proofs.test.ts (4 tests)
 Test Files  5 passed (5)
      Tests  18 passed (18)
```

```bash
bun run build
```
```
✓ built in 8.74s
[nitro] ✔ You can preview this build using node .output/server/index.mjs
```

`npx tsc --noEmit` and `npx eslint src` are clean.

## Hosting

The app builds with Nitro, which detects Vercel and needs no rewrites. Security headers (`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, HSTS) are Nitro route rules in `vite.config.ts`, because Nitro's Vercel build output replaces `vercel.json` headers; `NITRO_PRESET=vercel bun run build` writes them into `.vercel/output/config.json`. `.vercelignore` keeps `.env` files and build output out of uploads. Nitro is pinned to `nitro-nightly@3.0.1-20260109-100347-99691fcb`, the version the build was checked with. Set these at build time: `VITE_API_URL` (the hosted API), `VITE_NEAR_NETWORK=testnet`, `VITE_SHOP_CONTRACT_ID=shop4.ss-owner-e9c3db.testnet`, and `VITE_READONLY_DEMO=true` when the hosted API is read-only.

## Tests

| File | Proves |
|:-|:-|
| `src/lib/near/proofs.test.ts` | Commitment, release Merkle root and proofs match the backend and contract fixtures; a changed byte breaks the commitment; access keys fail closed |
| `src/lib/invoice.test.ts` | An invoice added in the owner app keeps the vendor's own layout (`lines` with `pay_to`, `items` with `remit_to` and a recent `period`, or `service` with `payment.account`), so the agent sees the shape it knows from that vendor |
| `src/lib/vaultPlan.test.ts` | The documented vault plan passes and its total is computed client-side; 16 tamperings are refused (an account-form contract id, an unbounded re-arm cooldown, a daily cap above the ceiling, an extra AddKey, a third transaction, another funding amount, other code, another owner or vendor, the Intents rail, a payee delay under an hour, key funding over 1 NEAR, a deposit on `new`, an overpriced or misdirected token registration, another signer); typed caps are enforced; CLI commands come only from checked values |
| `src/lib/csv.test.ts` | The ledger CSV parser handles the BOM, quotes, doubled quotes, commas and CRLF, and removes the formula guard only for display |
| `src/utils/near.test.ts` | Policy values in contract units (token base units, yoctoNEAR, nanoseconds) display as people read them |

## Stack and design

TanStack Start, Router and Query on React 19, Tailwind CSS 4, GSAP with Lenis smooth scroll, TypeScript strict, Bun, Vitest.

One dark look with three colors (ink `#0B0B0F`, paper `#EBEAE6`, cobalt `#3A4CFF`). Type is Archivo Variable, using its width axis for display text, with Geist Mono for data. Styles live in `src/styles/` (`base.css` shared, `home.css`, `pages.css` and `app.css` per area). Layouts are checked at 390, 820 and 1440 px: no page scrolls sideways, and on phones the owner app uses a bottom tab bar.

## Layout

```
src/
  routes/          file routes: /, /s/$shopId, /s/$shopId/tests/$slot, /app/*, /devices
  components/      page sections, wallet sheet, query states
  hooks/useShop.ts TanStack Query hooks for every contract view and API route
  lib/api/         API client (envelope, JWT) and typed routes
  lib/near/        RPC views, NEAR Connect wallet, browser proofs
  lib/invoice.ts   builds an invoice in a vendor's own layout
  config.ts        network, RPC, explorer, gas
```

## Logo

`public/logo.svg` is a vector trace of `brand/logo-source.svg` (the original 887 KB export with embedded PNGs) in cobalt `#3A4CFF`; `public/favicon.svg`, `favicon.ico` and `apple-touch-icon.png` put it on ink. To retrace: render the source large with `rsvg-convert`, threshold its alpha and run `potrace -s --turdsize 20`.
