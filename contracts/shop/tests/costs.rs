// Cost profile: gas burnt and vault storage per method. Run: cargo test --test costs -- --nocapture
mod common;
use common::*;
use near_workspaces::types::{Gas, KeyType, SecretKey};
use serde_json::{json, Value};

async fn storage(e: &Env) -> anyhow::Result<u64> {
    Ok(e.worker.view_account(e.shop.id()).await?.storage_usage)
}

async fn measure(
    e: &Env,
    label: &str,
    r: near_workspaces::result::ExecutionFinalResult,
    before: u64,
) -> anyhow::Result<()> {
    assert!(r.is_success(), "{label}: {:?}", r.failures());
    let after = storage(e).await?;
    println!(
        "COST | {label} | {:.2} Tgas | {} bytes",
        r.total_gas_burnt.as_gas() as f64 / 1e12,
        after as i64 - before as i64
    );
    Ok(())
}

#[tokio::test]
async fn cost_profile() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let call = |m: &str, a: Value| {
        e.agent
            .call(e.shop.id(), m)
            .args_json(a)
            .gas(Gas::from_tgas(80))
    };

    let b = storage(&e).await?;
    let r = call(
        "pay",
        json!({ "invoice_id": inv(1).1, "payee": "new.test.near", "amount": "1000" }),
    )
    .transact()
    .await?;
    measure(&e, "pay, new payee (registers on token)", r, b).await?;
    let b = storage(&e).await?;
    let r = call(
        "pay",
        json!({ "invoice_id": inv(2).1, "payee": "new.test.near", "amount": "1000" }),
    )
    .transact()
    .await?;
    measure(&e, "pay, known payee", r, b).await?;
    let b = storage(&e).await?;
    let r = call(
        "decline",
        json!({ "invoice_id": inv(3).1, "reason": "payee change needs verification by a human" }),
    )
    .transact()
    .await?;
    measure(&e, "decline", r, b).await?;

    let b = storage(&e).await?;
    let lure = Slot::lure(7, &implicit('f'), inv(5).0);
    let policy: Value = e.shop.view("get_policy").await?.json()?;
    let ttl: u64 = policy["test_ttl"].as_str().unwrap().parse::<u64>()? / 1_000_000_000;
    let round = (now_s(&e).await? + ttl + 2 - DRAND_GENESIS_S) / 3 + 2;
    let r = e
        .owner
        .call(e.shop.id(), "commit_batch")
        // three 871-byte tlock files, hashed and header-checked on chain
        .args_json(batch_args(
            &[
                Slot::lure(7, &implicit('f'), inv(5).0),
                Slot::void(8),
                Slot::void(9),
            ],
            round,
        ))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let slot = 0u32; // first batch
    measure(&e, "commit_batch, K=3 with tlock ciphertexts in args", r, b).await?;

    let b = storage(&e).await?;
    let r = call(
        "pay",
        json!({ "invoice_id": inv(5).1, "payee": lure.payee, "amount": "1000" }),
    )
    .transact()
    .await?;
    measure(&e, "pay, lure payee", r, b).await?;
    let b = storage(&e).await?;
    let r = e
        .owner
        .call(e.shop.id(), "reveal")
        .args_json(json!({
        "slot_id": slot, "salt": hex::encode(lure.salt), "payee": lure.payee,
        "invoice_id": inv(5).1, "receipt_hash": hex::encode(RECEIPT) }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    measure(&e, "reveal, failed test with demotion (key swap)", r, b).await?;
    let b = storage(&e).await?;
    let r = call(
        "propose",
        json!({ "invoice_id": inv(6).1, "payee": "supplier.test.near", "amount": "1000" }),
    )
    .transact()
    .await?;
    measure(&e, "propose", r, b).await?;
    let b = storage(&e).await?;
    let r = e
        .owner
        .call(e.shop.id(), "approve")
        .args_json(json!({ "proposal_id": 0 }))
        .deposit(YOCTO)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    measure(&e, "approve (owner, pays and registers)", r, b).await?;
    let b = storage(&e).await?;
    let r = e
        .owner
        .call(e.shop.id(), "add_payee")
        .args_json(json!({ "account_id": "listed.test.near", "label": "Northwind Office Supply" }))
        .deposit(YOCTO)
        .transact()
        .await?;
    measure(&e, "add_payee", r, b).await?;
    let b = storage(&e).await?;
    let r = e
        .owner
        .call(e.shop.id(), "freeze")
        .deposit(YOCTO)
        .gas(KEY_GAS)
        .transact()
        .await?;
    measure(&e, "freeze", r, b).await?;
    let b = storage(&e).await?;
    let pk = SecretKey::from_random(KeyType::ED25519).public_key();
    let r = e
        .owner
        .call(e.shop.id(), "propose_key")
        .args_json(json!({ "public_key": pk }))
        .deposit(YOCTO)
        .transact()
        .await?;
    measure(&e, "propose_key", r, b).await?;
    let b = storage(&e).await?;
    let r = e
        .vendor
        .call(e.shop.id(), "accept_key")
        .args_json(json!({ "public_key": pk }))
        .deposit(YOCTO)
        .gas(KEY_GAS)
        .transact()
        .await?;
    measure(&e, "accept_key", r, b).await?;
    println!(
        "COST | total vault storage after run | | {} bytes",
        storage(&e).await?
    );
    Ok(())
}
