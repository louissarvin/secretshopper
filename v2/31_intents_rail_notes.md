# 31. Intents rail notes (2026-11-10)

Follow-up to v2/29 section 2 and table row 6. Covers the vault option, the gas the contract attaches to Intents pays, and the 1Click payout quote preview.

## 1. Gas on the Intents rail

### What the contract attaches today

`contracts/shop/src/lib.rs`, `transfer()` with `Rail::Intents` (read on 2026-11-10, file not edited here):

| Step | Gas |
|:-|:-|
| `pay` own execution | 7.26 Tgas known payee, 9.38 Tgas new payee (v2/26_cost_profile.md) |
| `ft_transfer_call(intents_id, amount, memo, msg = payee)` on the token | `GAS_FT_CALL` = 60 Tgas static |
| `on_paid_intents` callback | `GAS_CB` = 10 Tgas static |

Both promises keep the near-sdk default unused-gas weight of 1 (`GasWeight::default()` is `GasWeight(1)`), so prepaid gas left after `pay` runs and the static amounts are reserved is split evenly between `ft_transfer_call` and the callback.

The agent signs `pay` with `AGENT_PAY_TGAS`, default 80 (`agent/src/config.ts:48`), for both rails. The rail does not change it. At 80 Tgas the leftover is about 1 Tgas, so `ft_transfer_call` runs with about 60 Tgas.

Inside the token, the near-contract-standards 5.29.1 `ft_transfer_call` (the fixture token in `contracts/shop/tests/fixtures/ft`) reserves 5 Tgas for `ft_resolve_transfer` and forwards all remaining gas to `ft_on_transfer` with weight 1. After the token's own work, `intents.near` `ft_on_transfer` receives roughly 50 Tgas. Mainnet USDC (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) is not the fixture contract, so its exact reservation is unverified.

### What the docs require

- `reference/docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits.md`: the deposit is `ft_transfer_call` with `receiver_id: intents.near` and `msg` set to the owning account id. Its `--gas` row says gas "depends on the `msg` content" and that "100 TGas is sufficient for a simple deposit". Both examples attach `teraToGas("100")`.
- The docs give no lower bound for `ft_on_transfer` itself. A plain account id in `msg` is the documented "simple deposit" case, which is what the vault sends.
- `reference/near-docs/protocol/transactions/gas.md`: one transaction may attach at most 1 PGas (1,000 Tgas), so 100 Tgas plus margin is well inside the limit.

### Finding

60 Tgas is below the only figure the Intents docs give (100 Tgas for a simple deposit). It is not proven too low, but nothing in the docs supports it. If `ft_on_transfer` runs out of gas, `ft_resolve_transfer` returns the whole amount to the vault, `on_paid_intents` sees `0` used and `settle` marks the payment `Failed` and gives the amount back to the rolling cap. No funds are lost. The cost is a failed payment whose invoice decision is already spent (`assert_new_decision`), so the agent cannot retry that invoice.

### Recommended values (for the engineer editing lib.rs)

| Constant | Now | Recommended | Why |
|:-|:-|:-|:-|
| `GAS_FT_CALL` | 60 Tgas | 100 Tgas | Matches deposits.md "100 TGas is sufficient for a simple deposit" |
| `GAS_CB` | 10 Tgas | 10 Tgas | `on_paid_intents` only runs `settle`; no change needed |
| Agent `pay` prepaid, Intents rail | 80 Tgas | 150 Tgas | 9.4 (pay) + 100 + 10 = about 120 Tgas, plus margin |
| Agent `pay` prepaid, Near rail | 80 Tgas | 80 Tgas | Unchanged |
| Owner `approve` of an Intents proposal | caller's choice | 150 Tgas or more | Same transfer path (`approve` calls `transfer`); about 9.3 Tgas own |

Coupling to keep in mind: once `GAS_FT_CALL` is 100, any `pay` or `approve` on the Intents rail with less than about 120 Tgas prepaid fails outright with "Exceeded the prepaid gas". That is safe because nothing moves, but the agent must use the higher value first. Raising only the agent's prepaid to 150 Tgas with the contract unchanged already gives `ft_transfer_call` about 95 Tgas through the weight split. That is a usable stopgap for the 2.0.0 testnet vault, but it does not guarantee the docs figure.

### Agent change needed (not made)

The agent does not tell rails apart when it picks gas. `agent/src/vault.ts` `pay()` always passes `o.payTgas`, and `agent/src/config.ts` has a single `PAY_TGAS`. The change:

1. Add `AGENT_PAY_INTENTS_TGAS` (default 150) to `agent/src/config.ts` and `payIntentsTgas` to `VaultOptions`.
2. In `vault.ts` `pay`, use `rail === 'Intents' ? o.payIntentsTgas : o.payTgas`.
3. Size the vault's `key_allowance` for it. One Intents pay at 150 Tgas holds about 0.015 NEAR of allowance until its refund lands.

## 2. Vault option

`scripts/create-vault.ts --intents <account>` now sets `intents_id`, which `scripts/lib/vault-deploy.ts` `checkIntents` validates:

- Mainnet: only `intents.near`, the Verifier contract per deposits.md. `--allow-unverified-intents` does not relax this.
- Testnet: refused, because NEAR Intents has no testnet deployment (`reference/docs.near-intents.org/resources/faqs.md`, `integration/verifier-contract/introduction.md`). `--allow-unverified-intents` allows it for local sandbox experiments only.
- The account must exist on the network (read-only preflight). The summary prints the rails.

## 3. Payout quote preview

`backend/src/lib/intents/quote.ts` `dryQuote()`, `GET /public/quote`, and `scripts/intents-quote.ts`.

- Request: `POST https://1click.chaindefuser.com/v0/quote` with `dry: true`, `swapType: EXACT_INPUT`, `originAsset: nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC on NEAR), `depositType: INTENTS`, `recipientType: DESTINATION_CHAIN`, `refundTo: <payee>`, `refundType: INTENTS` and a `deadline` 10 minutes out. `deadline` is required even for dry quotes (`api-reference/oneclick/request-a-swap-quote.md`). The destination asset must be in `GET /v0/tokens`.
- Auth: `X-API-Key: <ONECLICK_JWT>` only when the variable is set (`integration/distribution-channels/1click-api/authentication.md`). Without it, the docs say a 25 bps fee is added.
- The live API answers a dry quote with HTTP 201, not 200. A dry response has no `deadline`, `depositAddress` or `timeWhenInactive`.
- Observed on 2026-11-10: an unauthenticated USDC to USDC (Base) dry quote echoed `appFees: [{fee: 1}]`, not 25 bps. Same-asset stablecoin routes may be priced differently from the docs' general statement. The preview shows the echoed `appFees` next to the docs note instead of asserting 25 bps.
- 1Click rejects `0x000000000000000000000000000000000000dEaD` as a recipient ("recipient is not valid"). Tests use the docs' example address.
