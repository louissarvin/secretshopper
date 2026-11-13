// Audit 2.1.0 findings (V21-xx), turned into regressions after the fixes. Build the wasm first; run with --test-threads=4.
mod common;
use common::*;
use near_workspaces::types::{AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::Account;
use serde_json::{json, Value};

const MILLI: i128 = 1_000_000_000_000_000_000_000;
const BYTE: i128 = 10_000_000_000_000_000_000;

/// Vault NEAR above storage cost plus `float` (negative when the float is already eaten).
async fn free_near(e: &Env, float: i128) -> anyhow::Result<i128> {
    let a = e.worker.view_account(e.shop.id()).await?;
    Ok(a.balance.as_yoctonear() as i128 - a.storage_usage as i128 * BYTE - float)
}

async fn allowance(e: &Env) -> anyhow::Result<Option<u128>> {
    let k = e.shop.as_account().view_access_key(&e.agent_pk).await?;
    Ok(match k.permission {
        AccessKeyPermission::FunctionCall(f) => f.allowance.map(|a| a.as_yoctonear()),
        AccessKeyPermission::FullAccess => None,
    })
}

/// common::setup with a custom min_near_float.
async fn setup_float(float: i128) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let vendor = worker.dev_create_account().await?;
    let ft = worker
        .dev_deploy(&std::fs::read(
            "tests/fixtures/ft/target/near/fungible_token.wasm",
        )?)
        .await?;
    ft.call("new_default_meta")
        .args_json(json!({ "owner_id": owner.id(), "total_supply": (1_000 * USDC).to_string() }))
        .transact()
        .await?
        .into_result()?;
    let shop_acc = worker.dev_create_account().await?;
    let shop = shop_acc
        .deploy(&std::fs::read("target/near/secret_shopper.wasm")?)
        .await?
        .into_result()?;
    let mut p = policy(&Opts::default());
    p["min_near_float"] = json!(float.to_string());
    shop.call("new")
        .args_json(json!({
            "owner_id": owner.id(), "vendor_id": vendor.id(), "token_id": ft.id(),
            "intents_id": null, "policy": p
        }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": shop.id() }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(ft.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": shop.id(), "amount": (100 * USDC).to_string() }))
        .deposit(YOCTO)
        .transact()
        .await?
        .into_result()?;
    let fak = shop_acc.secret_key().public_key();
    shop_acc
        .batch(shop.id())
        .delete_key(fak)
        .transact()
        .await?
        .into_result()?;
    let agent_sk = SecretKey::from_random(KeyType::ED25519);
    let agent_pk = agent_sk.public_key();
    arm(&owner, &vendor, &shop, &agent_pk).await?;
    let agent = Account::from_secret_key(shop.id().clone(), agent_sk, &worker);
    Ok(Env {
        worker,
        shop,
        ft,
        owner,
        vendor,
        agent,
        agent_pk,
    })
}

// V21-01: gas signed by the agent key is paid by the vault and never meets assert_float. Fixed by bounding
// key_allowance to half the float: burning the whole allowance on failing calls still leaves the reveal its storage.
#[tokio::test]
async fn v21_01_agent_gas_cannot_block_its_own_demotion() -> anyhow::Result<()> {
    let float = 500 * MILLI; // key_allowance is 250 mNEAR in common::policy
    let e = setup_float(float).await?;
    let lure = Slot::lure(7, &implicit('f'), inv(5).0);
    let slot = commit(&e, &[lure.clone(), Slot::void(8), Slot::void(9)]).await?;
    let free = free_near(&e, float).await?;
    // 300 mNEAR of headroom: an FC-key tx reserves its prepaid gas at the pessimistic price from the vault first
    assert!(
        owner_call(
            &e,
            "withdraw_near",
            json!({ "amount": (free - 300 * MILLI).to_string() })
        )
        .await?
    );
    let r = e
        .agent
        .call(e.shop.id(), "pay")
        .args_json(
            json!({ "invoice_id": inv(5).1, "payee": lure.payee, "amount": USDC.to_string() }),
        )
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(
        r.is_success(),
        "agent pays the lure: {:?}",
        r.into_result().err()
    );

    // Step the prepaid gas down as the balance runs out; tx verification stops at the storage stake.
    let steps = [
        (900_000usize, 150u64),
        (900_000, 40),
        (900_000, 20),
        (200_000, 10),
        (20_000, 5),
        (1, 3),
    ];
    let (mut i, mut sent, mut retried) = (0usize, 0u32, false);
    while i < steps.len() {
        let (size, tgas) = steps[i];
        let r = e
            .agent
            .call(e.shop.id(), "decline")
            .args_json(json!({ "invoice_id": inv(5).1, "reason": "x".repeat(size) }))
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await;
        match r {
            Ok(_) => (sent, retried) = (sent + 1, false),
            Err(_) if !retried => {
                e.worker.fast_forward(2).await?; // pending gas refunds
                retried = true;
            }
            Err(_) => (i, retried) = (i + 1, false),
        }
        assert!(sent < 250, "burn loop runaway");
    }
    e.worker.fast_forward(3).await?;
    let left = free_near(&e, 0).await?;
    let burnt_allowance = allowance(&e).await?.expect("limited key");
    println!("{sent} failing agent txs; vault NEAR above storage {left} yocto, float {float}; allowance left {burnt_allowance}");
    assert!(
        left > 100 * MILLI,
        "the allowance runs out long before the reveal's storage is at risk"
    );

    // no top-up needed: the failure reveals and demotes
    assert_eq!(
        reveal(&e.owner, &e, slot, &lure).await?,
        Ok("Failed".into())
    );
    assert_eq!(scorecard(&e).await?["mode"], "Demoted");
    println!("allowance after demotion {:?}", allowance(&e).await?);
    Ok(())
}

// V21-02: assert_float reads storage_usage before Vector/LookupMap writes are flushed. Fixed with a 2,000-byte
// margin: a commit that would end below storage + float is refused instead.
#[tokio::test]
async fn v21_02_float_check_covers_lazily_flushed_writes() -> anyhow::Result<()> {
    let float = 500 * MILLI;
    let e = setup(Opts::default()).await?;
    let free = free_near(&e, float).await?;
    // 4 mNEAR covers the 3 commitment records LookupSet writes at once (3 x 109 B)
    assert!(
        owner_call(
            &e,
            "withdraw_near",
            json!({ "amount": (free - 4 * MILLI).to_string() })
        )
        .await?
    );
    let r = commit(&e, &[Slot::void(1), Slot::void(2), Slot::void(3)]).await;
    assert!(
        format!("{r:?}").contains("below the reveal float"),
        "refused up front: {r:?}"
    );
    assert!(free_near(&e, float).await? >= 0, "the float is intact");
    Ok(())
}

// V21-03: the parent may initialize only when it signs itself (relaying parents are refused). A parent that signs
// can still init a vault deployed and initialized in separate txs, so deploy and init atomically
// (scripts/create-vault.ts) and read get_status before funding; the Initialized event names the owner.
#[tokio::test]
async fn v21_03_parent_init_needs_an_atomic_deploy() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let parent = worker.root_account()?;
    // dev-*.test.near: created by test.near with the holder's key, code deployed, not yet initialized
    let vault = worker
        .dev_deploy(&std::fs::read("target/near/secret_shopper.wasm")?)
        .await?;
    let stranger = worker.dev_create_account().await?;
    let args = |owner: &str| {
        json!({ "owner_id": owner, "vendor_id": "vendor.test.near", "token_id": "usdc.test.near",
                "intents_id": null, "policy": policy(&Opts::default()) })
    };
    let r = stranger
        .call(vault.id(), "new")
        .args_json(args(stranger.id().as_str()))
        .transact()
        .await?;
    assert!(format!("{:?}", r.into_result().err()).contains("only the vault or its parent"));

    let r = parent
        .call(vault.id(), "new")
        .args_json(args(parent.id().as_str()))
        .transact()
        .await?;
    assert!(r.is_success(), "parent front-runs the holder's init");
    let r = vault
        .call("new")
        .args_json(args("holder.test.near"))
        .transact()
        .await?;
    assert!(r.is_failure(), "holder can no longer initialize");
    let st: Value = vault.view("get_status").await?.json()?;
    assert_eq!(st["owner_id"], parent.id().as_str());
    Ok(())
}

// Checked and fine: Misdirected cannot shield a payment to the lure payee, in either order.
#[tokio::test]
async fn v21_misdirected_does_not_shield_lure_payee() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let a = Slot::lure(1, &implicit('a'), inv(70).0);
    let b = Slot::lure(2, &implicit('b'), inv(71).0);
    let slot = commit(&e, &[a.clone(), b.clone(), Slot::void(3)]).await?;
    assert!(decline(&e, &inv(70).1).await, "declines lure A's invoice");
    assert!(
        pay(&e, &inv(72).1, &a.payee, USDC).await,
        "then pays A's payee elsewhere"
    );
    assert!(
        pay(&e, &inv(71).1, &implicit('9'), USDC).await,
        "pays lure B's invoice to another account"
    );
    assert!(
        pay(&e, &inv(73).1, &b.payee, USDC).await,
        "then pays B's payee elsewhere"
    );
    assert_eq!(reveal(&e.owner, &e, slot, &a).await?, Ok("Failed".into()));
    assert_eq!(
        reveal(&e.owner, &e, slot + 1, &b).await?,
        Ok("Failed".into())
    );
    let sc = scorecard(&e).await?;
    assert_eq!(sc["mode"], "Demoted");
    assert_eq!(sc["stats"]["failed"], 2);
    assert_eq!(sc["stats"]["misdirected"], 0);
    Ok(())
}
