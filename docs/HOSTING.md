# Hosted read-only demo on Vercel

A public, read-only copy of Secret Shopper for the hackathon judges: the web app and a read-only API on Vercel, a snapshot of the public tables in a Neon Postgres from the Vercel Marketplace, and the live NEAR testnet vault `shop4.ss-owner-e9c3db.testnet`. Nothing here signs a transaction, runs the tester or runs the agent.

Nothing in this document has been deployed yet. A human runs every step below; all names and commands were checked against the Vercel, Neon and Bun docs on 2026-11-12.

## Architecture

```
judge's browser
  ├── https://<web>.vercel.app      web/ (TanStack Start + Nitro, Vercel preset, Node runtime)
  │      ├── NEAR testnet RPC        live contract views (scorecard, status, payees), read in the browser
  │      └── https://<api>.vercel.app
  │             backend/api/server.ts  one Vercel Function, Bun 1.4 runtime, Bun.serve -> Fastify inject
  │               HOSTED_READONLY=1: only GET /, /health, /ready, GET /public/*, POST /public/vault-plan
  │               ├── Neon Postgres (role ss_ro: SELECT on 13 public tables, nothing else)
  │               ├── NEAR testnet RPC (live views behind /public/config, /scorecard, /vault, /schedule)
  │               └── 1Click (GET /public/quote, unauthenticated)
  └── local machine (not hosted)
         bun scripts/hosting-snapshot.ts   copies public rows from the local DB to Neon on demand
```

Why this shape:

- **Bun runtime, not the Fastify preset.** The backend uses Bun APIs (`import.meta.dir`, `Bun.sleep`) and `.ts` imports, so it needs the Bun runtime (`"bunVersion": "1.4.x"`, beta on all plans). Vercel's zero-config Fastify preset looks for an entry named `app`, `index` or `server` at the root or under `src/`; this package has both `index.ts` (starts the indexer, alerts and cron workers) and `src/app.ts` (no `listen`), so the preset could pick the wrong one. `backend/vercel.json` sets `"framework": null` and deploys only `api/server.ts`, the documented "Bun server from `/api`" model.
- **One function, every path.** A rewrite sends `/:path*` to `/api/server?__path=:path*`; `src/lib/hosted/bridge.ts` restores the path and runs the request through `app.inject()`, so CORS, rate limits, security headers and the read-only guard all apply. The client IP for rate limits comes from `x-real-ip`, which Vercel overwrites with the real client address.
- **Read-only twice.** `HOSTED_READONLY=1` (forced by `api/server.ts`) registers only the public route plugins and refuses anything else in an `onRequest` hook, and errors are logged to stdout only. The database role `ss_ro` can only `SELECT` the tables the public routes read, so even a bug in the guard cannot write.
- **Snapshot, not a cron indexer.** See [Live versus snapshot](#live-versus-snapshot).

## Live versus snapshot

| What the judge sees | Source | Fresh as of |
|:-|:-|:-|
| Scorecard, vault status, payees, policy, keys (web, read in the browser) | NEAR testnet RPC | Live |
| `GET /public/config`, `/public/scorecard/:shop`, `/public/vault/:id`, `/public/vault-template`, `/public/schedule/:shop`, `POST /public/vault-plan` | NEAR testnet RPC through the API (registered shop check reads the snapshot) | Live |
| `GET /public/quote` | 1Click | Live |
| `GET /public/model-runs` | `docs/pass-rate-*` and `docs/b1-blind-*.md`, copied into the deploy | Deploy time |
| `GET /public/tests`, `/public/tests/:shop/:slot`, `/public/evidence/:shop`, `/public/releases/:shop`, `/public/ledger/:shop`, `/public/blocklist` | Neon snapshot | Last `hosting-snapshot.ts` run |
| Sign-in, owner console, vendor console, inbox, every write route, tester, agent, indexer, alerts | Not hosted | Absent (404) |

**Cron was considered and rejected.** Vercel Hobby allows cron jobs at most once per day, fired anywhere in the scheduled hour (docs: Cron Jobs usage and pricing). A daily indexer would also need a writer database role inside the hosted function, which removes the read-only guarantee. Re-running the snapshot from the local machine after each reveal takes seconds and needs no redeploy (the API caches evidence for 30 s and tests not at all). On Pro, a per-minute cron calling an opt-in indexer route with `CRON_SECRET` and a separate writer URL would be possible; it is not built.

## What the snapshot copies

`scripts/hosting-snapshot.ts` reads the local database and writes the hosted one with an explicit column list per table, for the vaults named with `--shop`. It never touches schema `tester`, `User`, `AuthChallenge` or `ErrorLog`.

| Table | Copied | Withheld |
|:-|:-|:-|
| `companies` | all columns | |
| `vendors` | ids, legal name, approved payees, style set | `sampleInvoices` (private, SS-B05) set to `[]`, `contactEmail` set to `''` |
| `invoices` | ids and `deliverAt` of every invoice (the release Merkle roots need them) | `document` and `email` set to `{}` unless the invoice is a revealed lure |
| `tests` | the API's column grant from `prisma/roles.sql` | `sealed`; `invoiceRowId`, `aiReceiptId`, `receiptHash` forced to null for unrevealed slots |
| `ai_receipts` | receipts of revealed slots only | every other receipt (an unrevealed request body would name the lure) |
| `commitments`, `payments`, `proposals`, `keys`, `gen_log`, `ContractEvent` (this vault), `ChainCursor`, `blocklist_entries` (this vault) | all columns | |

It refuses to write into a target that already has rows unless `--replace` is passed (then it truncates the copied tables in the same transaction), refuses identical source and target, and never prints a connection string, including inside driver errors. `--dry-run` prints the row counts and writes nothing. Tested on 2026-11-12 against two throwaway local databases: withheld columns came out blank, other vaults and `User`, `ErrorLog`, `AuthChallenge` were not copied, a second run without `--replace` failed, and the hosted entry served the copy through a `SELECT`-only role, which refused an `INSERT`.

## Cost

Free, on the Vercel Hobby plan and the Neon Free plan through the Marketplace.

| Item | Free allowance (docs, 2026-11-12) | This demo |
|:-|:-|:-|
| Vercel Functions (Hobby, Fluid compute) | Free within the Hobby limits; 300 s max duration, 2 GB memory, 4.5 MB request or response body | Two projects, one API function with `maxDuration` 30 s |
| Bun runtime | Beta, all plans | API only |
| Neon Free | 1 GB storage and 100 CU-hours per project per month, scale to zero after 5 min idle | A snapshot of a few MB; the first request after idle waits for Neon to wake |
| Cron | Not used | |

Vercel Hobby is meant for personal, non-commercial use; a hackathon demo fits that, a company pilot would not.

## Steps for the human

Prerequisites: Bun 1.4.4, Vercel CLI 48.6.0 or newer (`npx vercel@latest`), the local API database with the indexer caught up on shop4, and the web changes in [Changes needed in web/](#changes-needed-in-web) applied by the web owner.

### 1. Log in

```bash
npx vercel@latest login
```

### 2. Create the Neon database

1. Vercel dashboard, **Storage**, **Create Database**, **Neon**, Free plan. Name it `secretshopper-demo`, region Washington D.C. (`iad1`, the Vercel Functions default). The CLI equivalent is `npx vercel@latest integration add neon`.
2. Do not use **Connect Project** for the API: that injects the owner role as `DATABASE_URL`. The API gets the read-only role by hand in step 5.
3. In the Neon console (**Open in Neon**), copy two connection strings for the owner role: the direct one (no `-pooler` in the host) for the schema push and the snapshot. Keep it in your shell only:

```bash
read -rs NEON_OWNER_URL && export NEON_OWNER_URL   # paste the direct owner URL, nothing is echoed
```

### 3. Create the schema on Neon

On the empty Neon database only. An explicit `DATABASE_URL` wins over `backend/.env`, which neither Bun nor dotenv overrides.

```bash
cd backend
DATABASE_URL="$NEON_OWNER_URL" bun run db:push
```

### 4. Create the read-only role

Open the Neon **SQL Editor**, paste [docs/hosting/readonly-role.sql](hosting/readonly-role.sql), replace the password (Neon requires 60 bits of entropy, for example `openssl rand -base64 24`) and run it. Then build the API's URL from the **pooled** owner URL by swapping the user and password for `ss_ro` and its password; keep `?sslmode=require`.

### 5. Copy the snapshot

```bash
cd scripts
read -rs SNAPSHOT_SOURCE_DATABASE_URL && export SNAPSHOT_SOURCE_DATABASE_URL   # the local URL from backend/.env
export SNAPSHOT_TARGET_DATABASE_URL="$NEON_OWNER_URL"
bun hosting-snapshot.ts --shop shop4.ss-owner-e9c3db.testnet --dry-run
bun hosting-snapshot.ts --shop shop4.ss-owner-e9c3db.testnet
```

Expected last line: `SNAPSHOT PASS: <n> rows copied for shop4.ss-owner-e9c3db.testnet.` To refresh later, add `--replace`.

### 6. Deploy the API

```bash
sh scripts/hosting-prepare.sh          # from the repo root: copies the model-run files into backend/hosted-docs
cd backend
npx vercel@latest link                 # create project "secretshopper-api" in your scope
```

Add the production variables. Each `env add` prompts for the value, so nothing lands in shell history; use `--sensitive` for the first three.

| Name | Value |
|:-|:-|
| `DATABASE_URL` | the pooled `ss_ro` URL from step 4 |
| `JWT_SECRET` | `openssl rand -hex 32` (required by config, unused: sign-in is not hosted) |
| `INBOX_TOKEN_HASH` | `openssl rand -hex 32` (required by config, unused: no inbox token exists) |
| `HOSTED_READONLY` | `1` (also forced by `api/server.ts`) |
| `NODE_ENV` | `production` |
| `SHOP_CONTRACT_ID` | `shop4.ss-owner-e9c3db.testnet` |
| `NEAR_NETWORK` | `testnet` |
| `CORS_ORIGINS` | `https://secretshopper-web.vercel.app` (the web's production URL; preview URLs are not allowed) |
| `AUTH_RECIPIENT` | `secretshopper-web.vercel.app` (production refuses `localhost`) |
| `LOG_LEVEL` | `info` |

```bash
npx vercel@latest env add DATABASE_URL --environment production --sensitive
npx vercel@latest env add JWT_SECRET --environment production --sensitive
npx vercel@latest env add INBOX_TOKEN_HASH --environment production --sensitive
npx vercel@latest env add HOSTED_READONLY --environment production --no-sensitive
# same for NODE_ENV, SHOP_CONTRACT_ID, NEAR_NETWORK, CORS_ORIGINS, AUTH_RECIPIENT, LOG_LEVEL
npx vercel@latest deploy --prod
```

Optional: `FASTNEAR_API_KEY` (sensitive) for higher RPC limits; `NEAR_RPC_URL`, `NEAR_RPC_URLS` to change the RPC. Leave `ONECLICK_JWT` unset so judges cannot spend a partner key.

`backend/.vercelignore` keeps `.env*`, `node_modules`, tests, `tester.ts` and `src/tester/` out of the upload; the CLI does not skip `.env` files on its own.

### 7. Deploy the web

After the web owner applied the changes below:

```bash
cd web
npx vercel@latest link                 # create project "secretshopper-web"
npx vercel@latest env add VITE_API_URL --environment production --no-sensitive          # https://secretshopper-api.vercel.app
npx vercel@latest env add VITE_NEAR_NETWORK --environment production --no-sensitive     # testnet
npx vercel@latest env add VITE_SHOP_CONTRACT_ID --environment production --no-sensitive # shop4.ss-owner-e9c3db.testnet
npx vercel@latest deploy --prod
```

`VITE_*` values are compiled into the bundle, so they must be set before the build and are public. If either project got a different `*.vercel.app` name than assumed, fix `CORS_ORIGINS`, `AUTH_RECIPIENT` or `VITE_API_URL` and redeploy that project (env changes apply only to new deployments).

### 8. Check it

```bash
curl -s https://secretshopper-api.vercel.app/ready                         # db ok
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://secretshopper-api.vercel.app/auth/nonce   # 404
cd scripts && API_URL=https://secretshopper-api.vercel.app WEB_ORIGIN=https://secretshopper-web.vercel.app bun api-smoke.ts
```

`api-smoke.ts` without `--owner` is read-only. Its "lists every committed slot" and "scorecard equals the chain" checks fail if a batch was committed after the last snapshot; re-run step 5 with `--replace`.

## Changes needed in web/

For the web owner; none were made by this change.

1. Replace `web/vercel.json` with [docs/hosting/web.vercel.json](hosting/web.vercel.json). The current SPA rewrite of every path to `/` fights Nitro's Vercel output, which routes server rendering and assets itself.
2. Add `web/.vercelignore` from [docs/hosting/web.vercelignore](hosting/web.vercelignore) so `.env` files are not uploaded.
3. Pin `nitro` to a fixed version: `"nitro": "npm:nitro-nightly@latest"` can change between two deploys of the same commit.
4. Nitro picks its Vercel preset automatically on Vercel builds; `vite.config.ts` needs no preset option. Do not add `engines.bun` to `web/package.json` unless the server should run on Bun (Nitro uses it to choose the runtime).
5. Read-only mode in the UI: on the hosted API, `/auth/*`, `/company/*`, `/vendors`, `/vendor/*`, `/invoices`, `/tests`, `/proposals`, `/inbox/*` and `POST /blocklist` return 404. The owner console (`/app`) and vendor console (`/vendor`) should say "Read-only demo: sign-in is disabled" instead of failing after a wallet signature. A build flag such as `VITE_READONLY_DEMO=true` added to `web/src/env.ts` would let the web hide sign-in and write actions.
6. The self-serve page (`/new`) keeps working: `GET /public/vault-template` and `POST /public/vault-plan` are served, and the transaction is signed in the judge's own wallet on testnet.
7. Update `web/.env.example`: it still lists the starter's variables, not `VITE_API_URL`, `VITE_NEAR_NETWORK`, `VITE_NEAR_RPC_URLS`, `VITE_SHOP_CONTRACT_ID`, `VITE_EXPLORER_URL` from `web/src/env.ts`.

## Teardown

Results are announced on Nov 18; keep both projects up until Nov 25, then:

```bash
npx vercel@latest project delete secretshopper-web
npx vercel@latest project delete secretshopper-api
rm -rf backend/.vercel web/.vercel backend/hosted-docs
```

Then in the Vercel dashboard: **Storage**, `secretshopper-demo`, **Settings**, **Delete Database** (this also removes `ss_ro`), and optionally uninstall the Neon integration under **Integrations**. No secret needs rotating: the hosted `JWT_SECRET` and `INBOX_TOKEN_HASH` were random throwaway values, and the `ss_ro` password dies with the database.

## Risks

- **Bun runtime is beta on Vercel.** If the build or runtime misbehaves, the fallback is the Node runtime, which would need `import.meta.dir` and `Bun.sleep` replaced in `src/config/main-config.ts`, `src/lib/alerts/webhook.ts` and `src/lib/near/events.ts`.
- **Rewrite path handling.** The bridge accepts the path from `__path` or from the raw URL, but the exact URL a `Bun.serve` function sees behind a rewrite was not confirmed in the docs. Check `/health` and one `/public/*` route right after the first deploy.
- **Snapshot staleness.** DB-backed routes lag the chain until the next snapshot; the scorecard read from the chain does not. Re-run step 5 after each reveal.
- **Rate limits are per instance.** `@fastify/rate-limit` keeps counts in memory, and Fluid compute may run several instances, so limits are approximate. The read-only role bounds the damage to read load on Neon and RPC.
- **Neon cold start.** After 5 minutes idle the first request waits for the database to wake; `/ready` may take a few seconds.
- **CORS and previews.** Only the production web origin is allowed; preview deployments of the web cannot call the API unless their origin is added to `CORS_ORIGINS`.
- **Public build values.** Everything in `VITE_*` is visible to anyone; none of them is a secret.
