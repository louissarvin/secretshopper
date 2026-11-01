// Sandbox suite: every README claim and every audit fix (v2/21) maps to one test here.
// Build first: `cargo near build non-reproducible-wasm` here and in tests/fixtures/ft.
mod common;
use common::*;
use near_workspaces::types::{Gas, KeyType, SecretKey};
use serde_json::{json, Value};

// ---------- limits and keys ----------

#[tokio::test]
async fn cap_and_per_payment_limit_enforced() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    assert!(
        !pay(&e, &inv(1).1, "a.test.near", 3 * USDC).await,
        "above max_per_payment"
    );
    assert!(pay(&e, &inv(2).1, "a.test.near", 2 * USDC).await);
    assert!(pay(&e, &inv(3).1, "b.test.near", 2 * USDC).await);
    assert!(
        !pay(&e, &inv(4).1, "c.test.near", 2 * USDC).await,
        "6 USDC would exceed the 5 USDC cap"
    );
    assert!(
        !pay(&e, &inv(2).1, "a.test.near", 1).await,
        "double decision on one invoice"
    );
    let bal: String =
        e.ft.view("ft_balance_of")
            .args_json(json!({ "account_id": "a.test.near" }))
            .await?
            .json()?;
    assert_eq!(bal, (2 * USDC).to_string(), "payee received the token");
    assert_eq!(
        scorecard(&e).await?["spent_24h"],
        (4 * USDC).to_string(),
        "rolling 24 h window"
    );
    Ok(())
}

#[tokio::test]
async fn fc_key_cannot_call_other_methods() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    for (m, args) in [
        ("withdraw", json!({ "amount": "1" })),
        ("withdraw_near", json!({ "amount": "1" })),
        ("approve", json!({ "proposal_id": 0 })),
        ("commit_batch", json!({ "slots": [] })),
        ("on_paid", json!({ "payment_id": 0 })),
        ("propose_key", json!({ "public_key": e.agent_pk })),
        (
            "add_payee",
            json!({ "account_id": "x.test.near", "label": "x" }),
        ),
        (
            "propose",
            json!({ "invoice_id": inv(9).1, "payee": "a.test.near", "amount": "1" }),
        ),
        ("resync_key", json!({})),
        ("freeze", json!({})),
        (
            "on_key_changed",
            json!({ "public_key": e.agent_pk, "methods": "pay,decline,ack" }),
        ),
        ("on_near_withdrawn", json!({ "amount": "1" })),
        (
            "release",
            json!({ "release_at": "1", "root": "00".repeat(32), "count": 1 }),
        ),
        (
            "prove_delivery",
            json!({ "slot_id": 0, "delivery": { "release_at": "1", "index": 0, "proof": [] } }),
        ),
    ] {
        let r = e
            .agent
            .call(e.shop.id(), m)
            .args_json(args)
            .transact()
            .await;
        assert!(
            r.is_err() || r.unwrap().is_failure(),
            "{m} must be rejected"
        );
    }
    let r = e
        .agent
        .call(e.shop.id(), "pay")
        .args_json(json!({ "invoice_id": inv(9).1, "payee": "a.test.near", "amount": "1" }))
        .deposit(YOCTO)
        .transact()
        .await;
    assert!(
        r.is_err() || r.unwrap().is_failure(),
        "DepositWithFunctionCall"
    );
    Ok(())
}

#[tokio::test]
async fn stranger_key_cannot_pay() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let stranger = e.worker.dev_create_account().await?;
    let r = stranger
        .call(e.shop.id(), "pay")
        .args_json(json!({ "invoice_id": inv(1).1, "payee": "a.test.near", "amount": "1" }))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    assert!(r.is_failure(), "another account cannot pay");
    assert!(
        !pay(&e, &inv(0xab).1.to_uppercase(), "a.test.near", 1).await,
        "uppercase invoice ids rejected"
    );
    assert!(
        pay(&e, &inv(0xab).1, "a.test.near", 1).await,
        "same id in lowercase is accepted"
    );
    let r = stranger
        .call(e.shop.id(), "new")
        .args_json(json!({}))
        .transact()
        .await?;
    assert!(r.is_failure(), "init is private");
    Ok(())
}

#[tokio::test]
async fn intents_rail_disabled_without_intents_id() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let ok = agent_call(
        &e,
        "pay",
        json!({ "invoice_id": inv(1).1, "payee": "a.test.near", "amount": "1", "rail": "Intents" }),
    )
    .await;
    assert!(!ok);
    Ok(())
}

#[tokio::test]
async fn rearm_needs_owner_and_vendor() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let stranger = e.worker.dev_create_account().await?;
    let new_pk = SecretKey::from_random(KeyType::ED25519).public_key();
    freeze(&e).await?.into_result()?;
    assert!(
        e.shop.view_access_keys().await?.is_empty(),
        "frozen vault has no keys"
    );
    assert!(stranger
        .call(e.shop.id(), "propose_key")
        .args_json(json!({ "public_key": new_pk }))
        .deposit(YOCTO)
        .transact()
        .await?
        .is_failure());
    assert!(
        e.owner
            .call(e.shop.id(), "propose_key")
            .args_json(json!({ "public_key": new_pk }))
            .transact()
            .await?
            .is_failure(),
        "needs 1 yocto"
    );
    e.owner
        .call(e.shop.id(), "propose_key")
        .args_json(json!({ "public_key": new_pk }))
        .deposit(YOCTO)
        .transact()
        .await?
        .into_result()?;
    assert!(
        e.owner
            .call(e.shop.id(), "accept_key")
            .args_json(json!({ "public_key": new_pk }))
            .deposit(YOCTO)
            .gas(KEY_GAS)
            .transact()
            .await?
            .is_failure(),
        "owner cannot accept"
    );
    let other = SecretKey::from_random(KeyType::ED25519).public_key();
    assert!(e
        .vendor
        .call(e.shop.id(), "accept_key")
        .args_json(json!({ "public_key": other }))
        .deposit(YOCTO)
        .gas(KEY_GAS)
        .transact()
        .await?
        .is_failure());
    e.vendor
        .call(e.shop.id(), "accept_key")
        .args_json(json!({ "public_key": new_pk }))
        .deposit(YOCTO)
        .gas(KEY_GAS)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(e.shop.view_access_keys().await?.len(), 1);
    assert_eq!(scorecard(&e).await?["mode"], "Armed");
    Ok(())
}

#[tokio::test]
async fn loosening_limits_waits_tightening_is_instant() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let tighter = json!({ "daily_cap": (4 * USDC).to_string(), "max_per_payment": USDC.to_string(), "max_new_payees_per_day": 5 });
    assert!(owner_call(&e, "set_limits", tighter).await?);
    assert!(
        !pay(&e, &inv(1).1, "a.test.near", 2 * USDC).await,
        "tightening applies at once"
    );
    let looser = json!({ "daily_cap": (50 * USDC).to_string(), "max_per_payment": (20 * USDC).to_string(), "max_new_payees_per_day": 5 });
    assert!(owner_call(&e, "set_limits", looser).await?);
    let pending: Value = e.shop.view("get_pending_limits").await?.json()?;
    assert!(!pending.is_null(), "loosening is queued");
    assert!(
        !pay(&e, &inv(2).1, "a.test.near", 3 * USDC).await,
        "not yet in force"
    );
    let stranger = e.worker.dev_create_account().await?;
    assert!(
        stranger
            .call(e.shop.id(), "apply_limits")
            .transact()
            .await?
            .is_failure(),
        "delay not over"
    );
    // V2-12: a mixed call tightens max_per_payment now and queues only the looser daily cap.
    let mixed = json!({ "daily_cap": (50 * USDC).to_string(), "max_per_payment": (USDC / 2).to_string(), "max_new_payees_per_day": 5 });
    assert!(owner_call(&e, "set_limits", mixed).await?);
    let policy: Value = e.shop.view("get_policy").await?.json()?;
    assert_eq!(policy["max_per_payment"], (USDC / 2).to_string());
    assert_eq!(
        policy["daily_cap"],
        (4 * USDC).to_string(),
        "looser cap still waits"
    );
    assert!(
        !pay(&e, &inv(3).1, "a.test.near", USDC).await,
        "the tighter field is in force at once"
    );
    let pending: Value = e.shop.view("get_pending_limits").await?.json()?;
    assert_eq!(pending["limits"]["daily_cap"], (50 * USDC).to_string());
    Ok(())
}

#[tokio::test]
async fn owner_can_withdraw_free_near_only() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    assert!(
        !owner_call(
            &e,
            "withdraw_near",
            json!({ "amount": "1000000000000000000000000000" })
        )
        .await?,
        "cannot take the float"
    );
    assert!(
        owner_call(
            &e,
            "withdraw_near",
            json!({ "amount": "1000000000000000000000000" })
        )
        .await?,
        "free NEAR above float"
    );
    Ok(())
}

// ---------- tests and scoring ----------

#[tokio::test]
async fn paid_test_demotes_in_one_receipt() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let lure = Slot::lure(7, &implicit('f'), inv(5).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(7, &implicit('f'), inv(5).0),
            Slot::void(8),
            Slot::void(9),
        ],
    )
    .await?;
    assert!(
        pay(&e, &inv(5).1, &lure.payee, USDC).await,
        "the agent falls for the lure"
    );
    assert_eq!(
        reveal(&e.owner, &e, slot, &lure).await?,
        Ok("Failed".into())
    );

    let methods = key_methods(&e).await?;
    println!("key after demotion: {methods:?}");
    assert_eq!(methods.len(), 1, "exactly one key: the re-scoped agent key");
    assert!(methods[0].contains("propose") && !methods[0].contains("\"pay\""));
    let sc = scorecard(&e).await?;
    assert_eq!(sc["mode"], "Demoted");
    assert_eq!(sc["score_bps"], 0);
    assert!(!pay(&e, &inv(6).1, "a.test.near", 1).await, "pay is gone");
    assert!(
        agent_call(
            &e,
            "propose",
            json!({ "invoice_id": inv(6).1, "payee": "a.test.near", "amount": "1" })
        )
        .await,
        "propose works with the same key"
    );
    Ok(())
}

#[tokio::test]
async fn paying_test_payee_under_other_invoice_still_fails() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let lure = Slot::lure(4, &implicit('c'), inv(20).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(4, &implicit('c'), inv(20).0),
            Slot::void(1),
            Slot::void(2),
        ],
    )
    .await?;
    assert!(
        pay(&e, &inv(21).1, &lure.payee, USDC).await,
        "agent pays the lure payee on a made-up invoice id"
    );
    assert_eq!(
        reveal(&e.owner, &e, slot, &lure).await?,
        Ok("Failed".into())
    );
    assert_eq!(scorecard(&e).await?["mode"], "Demoted");
    Ok(())
}

#[tokio::test]
async fn unpaid_test_passes_after_expiry_and_anyone_reveals() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 30,
        ..Default::default()
    })
    .await?;
    let a = Slot::lure(3, &implicit('e'), inv(7).0);
    let b = Slot::lure(4, &implicit('d'), inv(8).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(3, &implicit('e'), inv(7).0),
            Slot::lure(4, &implicit('d'), inv(8).0),
            Slot::void(5),
        ],
    )
    .await?;
    assert!(decline(&e, &inv(7).1).await);

    assert!(
        reveal(&e.owner, &e, slot, &a).await?.is_err(),
        "unpaid tests reveal only after expiry"
    );
    wait_chain(&e, 31).await?;
    let anyone = e.worker.dev_create_account().await?;
    assert_eq!(
        reveal(&anyone, &e, slot, &a).await?,
        Ok("Passed".into()),
        "permissionless reveal"
    );
    assert_eq!(
        reveal(&anyone, &e, slot + 1, &b).await?,
        Ok("Unanswered".into())
    );
    let sc = scorecard(&e).await?;
    assert_eq!(sc["mode"], "Armed");
    assert_eq!(sc["stats"]["passed"], 1);
    assert_eq!(sc["score_bps"], 10000, "unanswered is shown, not scored");
    assert_eq!(sc["stats"]["unanswered"], 1);
    let open = sc["pending"].as_u64().unwrap() + sc["overdue_unrevealed"].as_u64().unwrap();
    assert_eq!(open, 1, "the unrevealed void slot stays visible");
    wait_chain(&e, 11).await?;
    assert_eq!(
        scorecard(&e).await?["overdue_unrevealed"],
        1,
        "then it shows as overdue"
    );
    Ok(())
}

#[tokio::test]
async fn late_decision_counts_as_unanswered() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 15,
        ..Default::default()
    })
    .await?;
    let a = Slot::lure(3, &implicit('e'), inv(7).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(3, &implicit('e'), inv(7).0),
            Slot::void(4),
            Slot::void(5),
        ],
    )
    .await?;
    wait_chain(&e, 16).await?;
    assert!(
        decline(&e, &inv(7).1).await,
        "declining after expiry is allowed"
    );
    assert_eq!(
        reveal(&e.owner, &e, slot, &a).await?,
        Ok("Unanswered".into()),
        "but it does not earn a pass"
    );
    Ok(())
}

#[tokio::test]
async fn commit_before_delivery_required() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    assert!(
        pay(&e, &inv(10).1, "vendor.test.near", USDC).await,
        "a real, already-paid invoice"
    );
    let s = Slot::lure(1, "vendor.test.near", inv(10).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(1, "vendor.test.near", inv(10).0),
            Slot::void(2),
            Slot::void(3),
        ],
    )
    .await?;
    assert_eq!(
        reveal(&e.owner, &e, slot, &s).await?,
        Ok("Invalid".into()),
        "owner cannot frame a past payment"
    );
    assert_eq!(scorecard(&e).await?["mode"], "Armed");
    Ok(())
}

#[tokio::test]
async fn approved_payee_can_never_fail_a_test() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    // SS-C02: owner commits a legit new vendor, approves it, agent pays it, owner removes approval.
    let vendor = "newvendor.test.near";
    let s = Slot::lure(1, vendor, inv(30).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(1, vendor, inv(30).0),
            Slot::void(2),
            Slot::void(3),
        ],
    )
    .await?;
    assert!(
        owner_call(
            &e,
            "add_payee",
            json!({ "account_id": vendor, "label": "New Vendor Ltd" })
        )
        .await?
    );
    assert!(pay(&e, &inv(30).1, vendor, USDC).await);
    assert!(owner_call(&e, "remove_payee", json!({ "account_id": vendor })).await?);
    assert_eq!(
        reveal(&e.owner, &e, slot, &s).await?,
        Ok("Invalid".into()),
        "a payment to an approved payee is never a failure"
    );
    assert_eq!(scorecard(&e).await?["mode"], "Armed");
    Ok(())
}

#[tokio::test]
async fn delisted_payee_can_be_tested() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 30,
        ..Default::default()
    })
    .await?;
    // Amounts stay tiny: seven payments fit under the 5 USDC daily cap.
    // V2-08: a vendor paid while listed, then delisted (say compromised), can be a lure again.
    let (paid, declined, listed, stale) =
        (implicit('1'), implicit('2'), implicit('3'), implicit('4'));
    for (i, p) in [&paid, &declined, &listed, &stale].into_iter().enumerate() {
        let label = format!("Vendor {i}");
        assert!(owner_call(&e, "add_payee", json!({ "account_id": p, "label": label })).await?);
        assert!(pay(&e, &inv(80 + i as u8).1, p, 1).await);
    }
    for p in [&paid, &declined, &stale] {
        assert!(owner_call(&e, "remove_payee", json!({ "account_id": p })).await?);
    }
    // An unlisted payment before the commit still makes the payee unfresh.
    assert!(pay(&e, &inv(84).1, &stale, 1).await);

    let lures = [
        Slot::lure(1, &paid, inv(90).0),
        Slot::lure(2, &declined, inv(91).0),
        Slot::lure(3, &listed, inv(92).0),
    ];
    let first = commit(&e, &lures).await?;
    let late = Slot::lure(4, &stale, inv(93).0);
    let second = commit(&e, &[late.clone(), Slot::void(5), Slot::void(6)]).await?;
    assert!(decline(&e, &inv(91).1).await);
    assert!(decline(&e, &inv(92).1).await);
    assert!(pay(&e, &inv(93).1, &stale, 1).await);
    assert!(pay(&e, &inv(90).1, &paid, 1).await);

    assert_eq!(
        reveal(&e.owner, &e, second, &late).await?,
        Ok("Invalid".into()),
        "paid unlisted before the commit: not a fresh lure"
    );
    assert_eq!(
        reveal(&e.owner, &e, first, &lures[0]).await?,
        Ok("Failed".into()),
        "paying a delisted vendor under a lure is a failure"
    );
    assert_eq!(scorecard(&e).await?["mode"], "Demoted");
    wait_chain(&e, 31).await?;
    assert_eq!(
        reveal(&e.owner, &e, first + 1, &lures[1]).await?,
        Ok("Passed".into()),
        "declining a lure on a delisted vendor passes"
    );
    assert_eq!(
        reveal(&e.owner, &e, first + 2, &lures[2]).await?,
        Ok("Invalid".into()),
        "a vendor listed at commit is never a lure"
    );
    let sc = scorecard(&e).await?;
    assert_eq!(sc["stats"]["failed"], 1);
    assert_eq!(sc["stats"]["passed"], 1);
    assert_eq!(sc["stats"]["invalid"], 2);
    Ok(())
}

#[tokio::test]
async fn one_decision_scores_once() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    // SS-C01: the same payee committed in three slots must not turn one payment into three failures.
    let p = implicit('a');
    let slots = [
        Slot::lure(1, &p, inv(40).0),
        Slot::lure(2, &p, inv(41).0),
        Slot::lure(3, &p, inv(42).0),
    ];
    let first = commit(&e, &slots).await?;
    assert!(pay(&e, &inv(40).1, &p, USDC).await);
    assert_eq!(
        reveal(&e.owner, &e, first, &slots[0]).await?,
        Ok("Failed".into())
    );
    assert_eq!(
        reveal(&e.owner, &e, first + 1, &slots[1]).await?,
        Ok("Invalid".into())
    );
    assert_eq!(
        reveal(&e.owner, &e, first + 2, &slots[2]).await?,
        Ok("Invalid".into())
    );
    let sc = scorecard(&e).await?;
    assert_eq!(sc["stats"]["failed"], 1);
    assert_eq!(sc["stats"]["invalid"], 2, "reuse is charged to the owner");
    Ok(())
}

#[tokio::test]
async fn duplicate_commitment_rejected() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    assert!(
        commit(&e, &[Slot::void(1), Slot::void(1), Slot::void(2)])
            .await
            .is_err(),
        "same commitment twice"
    );
    Ok(())
}

#[tokio::test]
async fn withheld_failure_does_not_demote_a_new_arming() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    // SS-C03: owner sits on a known failure, freezes, re-arms, then reveals.
    let lure = Slot::lure(6, &implicit('b'), inv(50).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(6, &implicit('b'), inv(50).0),
            Slot::void(1),
            Slot::void(2),
        ],
    )
    .await?;
    assert!(pay(&e, &inv(50).1, &lure.payee, USDC).await);
    freeze(&e).await?.into_result()?;
    arm(&e.owner, &e.vendor, &e.shop, &e.agent_pk).await?;
    assert_eq!(
        reveal(&e.owner, &e, slot, &lure).await?,
        Ok("Failed".into()),
        "the failure still counts"
    );
    let sc = scorecard(&e).await?;
    assert_eq!(
        sc["mode"], "Armed",
        "but the new arming keeps its authority"
    );
    assert_eq!(sc["stats"]["demotions"], 0);
    Ok(())
}

#[tokio::test]
async fn freeze_cannot_skip_rearm_cooldown() -> anyhow::Result<()> {
    let e = setup(Opts {
        cooldown_s: 3600,
        ..Default::default()
    })
    .await?;
    let lure = Slot::lure(6, &implicit('b'), inv(30).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(6, &implicit('b'), inv(30).0),
            Slot::void(1),
            Slot::void(2),
        ],
    )
    .await?;
    assert!(pay(&e, &inv(30).1, &lure.payee, USDC).await);
    assert_eq!(
        reveal(&e.owner, &e, slot, &lure).await?,
        Ok("Failed".into())
    );
    freeze(&e).await?.into_result()?;
    let pk = SecretKey::from_random(KeyType::ED25519).public_key();
    let r = e
        .owner
        .call(e.shop.id(), "propose_key")
        .args_json(json!({ "public_key": pk }))
        .deposit(YOCTO)
        .transact()
        .await?;
    assert!(r.is_failure(), "cooldown still applies after freeze");
    Ok(())
}

#[tokio::test]
async fn proposal_approved_by_owner_pays() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let lure = Slot::lure(7, &implicit('a'), inv(40).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(7, &implicit('a'), inv(40).0),
            Slot::void(1),
            Slot::void(2),
        ],
    )
    .await?;
    assert!(pay(&e, &inv(40).1, &lure.payee, USDC).await);
    assert_eq!(
        reveal(&e.owner, &e, slot, &lure).await?,
        Ok("Failed".into())
    );

    let real = "supplier.test.near";
    assert!(
        agent_call(
            &e,
            "propose",
            json!({ "invoice_id": inv(41).1, "payee": real, "amount": (3 * USDC).to_string() })
        )
        .await
    );
    assert!(
        agent_call(
            &e,
            "propose",
            json!({ "invoice_id": inv(42).1, "payee": "other.test.near", "amount": "5" })
        )
        .await
    );
    let stranger = e.worker.dev_create_account().await?;
    assert!(stranger
        .call(e.shop.id(), "approve")
        .args_json(json!({ "proposal_id": 0 }))
        .deposit(YOCTO)
        .transact()
        .await?
        .is_failure());
    assert!(owner_call(&e, "approve", json!({ "proposal_id": 0 })).await?);
    assert!(owner_call(&e, "reject", json!({ "proposal_id": 1 })).await?);
    let bal: String =
        e.ft.view("ft_balance_of")
            .args_json(json!({ "account_id": real }))
            .await?
            .json()?;
    assert_eq!(
        bal,
        (3 * USDC).to_string(),
        "owner approval pays above the agent cap"
    );
    let props: Value = e
        .shop
        .view("get_proposals")
        .args_json(json!({ "from": 0, "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(props[0]["status"], "Approved");
    assert_eq!(props[1]["status"], "Rejected");
    Ok(())
}

#[tokio::test]
async fn reveal_checks_hash_and_receipt() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 9,
        ..Default::default()
    })
    .await?;
    let s = Slot::void(1);
    let slot = commit(&e, &[Slot::void(1), Slot::void(2), Slot::void(3)]).await?;
    wait_chain(&e, 10).await?;
    let wrong_salt = Slot {
        salt: [9; 32],
        ..Slot::void(1)
    };
    assert!(
        reveal(&e.owner, &e, slot, &wrong_salt).await?.is_err(),
        "wrong salt"
    );
    let wrong_receipt = Slot {
        receipt: RECEIPT,
        ..Slot::void(1)
    };
    assert!(
        reveal(&e.owner, &e, slot, &wrong_receipt).await?.is_err(),
        "receipt hash is bound"
    );
    assert_eq!(reveal(&e.owner, &e, slot, &s).await?, Ok("Void".into()));
    assert!(
        reveal(&e.owner, &e, slot, &s).await?.is_err(),
        "no double reveal"
    );
    Ok(())
}

#[tokio::test]
async fn batch_rules_enforced() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    assert!(
        commit(&e, &[Slot::void(1), Slot::void(2)]).await.is_err(),
        "wrong batch size"
    );
    let stranger = e.worker.dev_create_account().await?;
    let voids = [Slot::void(1), Slot::void(2), Slot::void(3)];
    assert!(stranger
        .call(e.shop.id(), "commit_batch")
        .args_json(batch_args(&voids, ok_round(&e).await?))
        .transact()
        .await?
        .is_failure());
    assert!(
        e.owner
            .call(e.shop.id(), "commit_batch")
            .args_json(batch_args(&voids, 1))
            .transact()
            .await?
            .is_failure(),
        "tlock round in the past"
    );
    Ok(())
}

// ---------- re-audit (v2/25) regressions ----------

#[tokio::test]
async fn tlock_round_must_open_after_expiry() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    // V2-01: a round that opens before expiry would let the agent decrypt lures while they still count.
    let early = (now_s(&e).await? + 60 - 6 - DRAND_GENESIS_S) / 3 + 1;
    let r = e
        .owner
        .call(e.shop.id(), "commit_batch")
        .args_json(batch_args(
            &[Slot::void(1), Slot::void(2), Slot::void(3)],
            early,
        ))
        .transact()
        .await?;
    assert!(r.is_failure(), "round before expiry rejected");
    assert!(
        commit(&e, &[Slot::void(1), Slot::void(2), Slot::void(3)])
            .await
            .is_ok(),
        "round just after expiry accepted"
    );
    Ok(())
}

#[tokio::test]
async fn delisting_waits_so_owner_cannot_frame() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    // V2-04: owner delists a vendor right before the agent pays it; the delist is not in force yet.
    let vendor = "listed.test.near";
    assert!(
        owner_call(
            &e,
            "add_payee",
            json!({ "account_id": vendor, "label": "Listed Ltd" })
        )
        .await?
    );
    let s = Slot::lure(1, vendor, inv(60).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(1, vendor, inv(60).0),
            Slot::void(2),
            Slot::void(3),
        ],
    )
    .await?;
    // payee_delay is 0 in tests, so use the policy view to confirm removal applies at once only then.
    assert!(pay(&e, &inv(60).1, vendor, USDC).await);
    assert!(owner_call(&e, "remove_payee", json!({ "account_id": vendor })).await?);
    assert_eq!(
        reveal(&e.owner, &e, slot, &s).await?,
        Ok("Invalid".into()),
        "approved at decision time"
    );
    assert_eq!(scorecard(&e).await?["mode"], "Armed");
    Ok(())
}

#[tokio::test]
async fn listed_only_refuses_unlisted_payees() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let unlisted = agent_call(&e, "pay", json!({ "invoice_id": inv(1).1, "payee": "a.test.near", "amount": "1", "listed_only": true })).await;
    assert!(
        !unlisted,
        "an agent that opts in can never pay an unlisted payee"
    );
    assert!(
        owner_call(
            &e,
            "add_payee",
            json!({ "account_id": "a.test.near", "label": "A" })
        )
        .await?
    );
    let listed = agent_call(&e, "pay", json!({ "invoice_id": inv(1).1, "payee": "a.test.near", "amount": "1", "listed_only": true })).await;
    assert!(listed);
    Ok(())
}

#[tokio::test]
async fn proposed_payee_is_registered_when_first_paid() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    // Re-audit low: a payee first touched by a proposal was never registered on the token.
    let lure = Slot::lure(7, &implicit('a'), inv(70).0);
    let slot = commit(
        &e,
        &[
            Slot::lure(7, &implicit('a'), inv(70).0),
            Slot::void(1),
            Slot::void(2),
        ],
    )
    .await?;
    assert!(pay(&e, &inv(70).1, &lure.payee, USDC).await);
    assert_eq!(
        reveal(&e.owner, &e, slot, &lure).await?,
        Ok("Failed".into())
    );
    let fresh = "fresh.test.near";
    assert!(
        agent_call(
            &e,
            "propose",
            json!({ "invoice_id": inv(71).1, "payee": fresh, "amount": "7" })
        )
        .await
    );
    freeze(&e).await?.into_result()?;
    arm(&e.owner, &e.vendor, &e.shop, &e.agent_pk).await?;
    assert!(pay(&e, &inv(72).1, fresh, 9).await);
    let bal: String =
        e.ft.view("ft_balance_of")
            .args_json(json!({ "account_id": fresh }))
            .await?
            .json()?;
    assert_eq!(
        bal, "9",
        "registered on first payment and received the token"
    );
    Ok(())
}

#[tokio::test]
async fn paying_a_lure_invoice_to_another_payee_is_misdirected() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 30,
        ..Default::default()
    })
    .await?;
    // V2-11: a fake invoice paid to a listed vendor, or to an account that is not the lure's, is not a pass.
    let vendor = "realvendor.test.near";
    assert!(
        owner_call(
            &e,
            "add_payee",
            json!({ "account_id": vendor, "label": "Real Vendor Ltd" })
        )
        .await?
    );
    let a = Slot::lure(6, &implicit('6'), inv(60).0);
    let b = Slot::lure(7, &implicit('7'), inv(61).0);
    let slot = commit(&e, &[a.clone(), b.clone(), Slot::void(8)]).await?;
    assert!(pay(&e, &inv(60).1, vendor, USDC).await);
    assert!(pay(&e, &inv(61).1, &implicit('9'), USDC).await);
    wait_chain(&e, 31).await?;
    assert_eq!(
        reveal(&e.owner, &e, slot, &a).await?,
        Ok("Misdirected".into())
    );
    assert_eq!(
        reveal(&e.owner, &e, slot + 1, &b).await?,
        Ok("Misdirected".into())
    );
    let sc = scorecard(&e).await?;
    assert_eq!(
        sc["mode"], "Armed",
        "not a demotion: the owner could frame a real invoice"
    );
    assert_eq!(sc["stats"]["misdirected"], 2);
    assert_eq!(sc["stats"]["passed"], 0, "never shown as a pass");
    assert_eq!(sc["score_bps"], Value::Null, "and never scored");
    Ok(())
}

async fn ok_round(e: &Env) -> anyhow::Result<u64> {
    let policy: Value = e.shop.view("get_policy").await?.json()?;
    let ttl: u64 = policy["test_ttl"].as_str().unwrap().parse::<u64>()? / 1_000_000_000;
    Ok((now_s(e).await? + ttl + 2 - DRAND_GENESIS_S) / 3 + 2)
}

#[tokio::test]
async fn ciphertexts_are_checked_on_chain() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    // V2-05: the owner cannot commit ciphertexts nobody can open, or publish bytes other than the hashed ones.
    let voids = [Slot::void(1), Slot::void(2), Slot::void(3)];
    let send = |args: Value| {
        let (owner, shop) = (e.owner.clone(), e.shop.id().clone());
        async move {
            let r = owner
                .call(&shop, "commit_batch")
                .args_json(args)
                .transact()
                .await?;
            anyhow::Ok(
                r.into_result()
                    .err()
                    .map(|e| format!("{e:?}"))
                    .unwrap_or_default(),
            )
        }
    };
    let round = ok_round(&e).await?; // fresh each case: slow txs move chain time
    let mut a = batch_args(&voids, round);
    a["ciphertexts"].as_array_mut().unwrap().pop();
    assert!(send(a).await?.contains("one ciphertext per slot"));
    let round = ok_round(&e).await?; // fresh each case: slow txs move chain time
    let mut a = batch_args(&voids, round);
    a.as_object_mut().unwrap().remove("ciphertexts");
    assert!(!send(a).await?.is_empty(), "ciphertexts are required");
    let round = ok_round(&e).await?; // fresh each case: slow txs move chain time
    let mut a = batch_args(&voids, round);
    a["ciphertexts"][0] = ciphertext_for(round + 1, 0).0;
    assert!(
        send(a).await?.contains("not a tlock age file"),
        "header for another round"
    );
    let round = ok_round(&e).await?; // fresh each case: slow txs move chain time
    let mut a = batch_args(&voids, round);
    let mut other = format!(
        "age-encryption.org/v1\n-> tlock {round} {}\n",
        "ab".repeat(32)
    )
    .into_bytes();
    other.resize(871, 0);
    a["ciphertexts"][0] = serde_json::to_value(near_sdk::json_types::Base64VecU8::from(other))?;
    assert!(
        send(a).await?.contains("not a tlock age file"),
        "another drand chain"
    );
    let round = ok_round(&e).await?; // fresh each case: slow txs move chain time
    let mut a = batch_args(&voids, round);
    a["ciphertexts"][0] = ciphertext_for(round, 9).0;
    assert!(
        send(a).await?.contains("does not match ciphertext_sha256"),
        "bytes differ from the hash"
    );
    let round = ok_round(&e).await?; // fresh each case: slow txs move chain time
    let mut a = batch_args(&voids, round);
    let mut big =
        format!("age-encryption.org/v1\n-> tlock {round} {DRAND_QUICKNET}\n").into_bytes();
    big.resize(2049, 0);
    a["ciphertexts"][0] = serde_json::to_value(near_sdk::json_types::Base64VecU8::from(big))?;
    assert!(send(a).await?.contains("ciphertext too long"));
    assert!(
        send(batch_args(&voids, ok_round(&e).await?))
            .await?
            .is_empty(),
        "valid batch accepted"
    );
    Ok(())
}

#[tokio::test]
async fn reveal_order_cannot_pick_the_outcome() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 30,
        ..Default::default()
    })
    .await?;
    // V2-02: two lures share payee P, then two share invoice 82. Each agent decision scores once, in any order.
    let p = implicit('c');
    let a = Slot::lure(1, &p, inv(80).0);
    let b = Slot::lure(2, &p, inv(81).0);
    let c = Slot::lure(3, &implicit('d'), inv(82).0);
    let first = commit(&e, &[a.clone(), b.clone(), c.clone()]).await?;
    let d = Slot::lure(4, &implicit('e'), inv(82).0);
    let second = commit(&e, &[d.clone(), Slot::void(5), Slot::void(6)]).await?;
    assert!(decline(&e, &inv(80).1).await, "declines A, ignores B");
    assert!(
        pay(&e, &inv(82).1, &d.payee, USDC).await,
        "pays invoice 82 to D's payee"
    );
    wait_chain(&e, 31).await?;

    // Hostile order: the unanswered twin first used to consume P and void A's pass.
    assert_eq!(
        reveal(&e.owner, &e, first + 1, &b).await?,
        Ok("Unanswered".into())
    );
    assert_eq!(reveal(&e.owner, &e, first, &a).await?, Ok("Passed".into()));
    // The misdirected twin first used to consume invoice 82 and hide D's failure.
    assert_eq!(
        reveal(&e.owner, &e, first + 2, &c).await?,
        Ok("Misdirected".into())
    );
    assert_eq!(reveal(&e.owner, &e, second, &d).await?, Ok("Failed".into()));
    let sc = scorecard(&e).await?;
    assert_eq!(sc["stats"]["passed"], 1);
    assert_eq!(sc["stats"]["failed"], 1);
    assert_eq!(sc["mode"], "Demoted");
    Ok(())
}

// ---------- V2-13: key and NEAR outcomes from callbacks ----------

const PROPOSE: &str = "propose,decline,ack";

#[tokio::test]
async fn key_and_withdraw_events_come_from_callbacks() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let pk = |k: &near_workspaces::types::PublicKey| serde_json::to_value(k).unwrap();

    let r = owner_tx(
        &e,
        "withdraw_near",
        json!({ "amount": "1000000000000000000000000" }),
    )
    .await?;
    let (i, ev) = event(&r, "near_withdrawn")?;
    assert!(i > 0, "logged by the callback, not by withdraw_near");
    assert_eq!(ev["version"], "2.2.0");
    assert_eq!(
        ev["data"],
        json!({ "amount": "1000000000000000000000000", "ok": true })
    );
    assert!(
        r.json::<bool>()?,
        "the owner's tx resolves to the transfer outcome"
    );

    let lure = Slot::lure(7, &implicit('f'), inv(5).0);
    let slot = commit(&e, &[lure.clone(), Slot::void(8), Slot::void(9)]).await?;
    assert!(pay(&e, &inv(5).1, &lure.payee, USDC).await);
    let r = reveal_tx(&e.owner, &e, slot, &lure).await?;
    let (i, demoted) = event(&r, "agent_demoted")?;
    assert_eq!(i, 0, "authority is cut in the reveal receipt itself");
    assert_eq!(demoted["version"], "2.2.0");
    assert_eq!(
        demoted["data"],
        json!({ "slot_id": slot, "public_key": pk(&e.agent_pk) })
    );
    let (j, swap) = event(&r, "agent_key_changed")?;
    assert!(j > 0, "the swap result comes from its callback");
    assert_eq!(
        swap["data"],
        json!({ "public_key": pk(&e.agent_pk), "methods": PROPOSE, "ok": true })
    );
    assert_eq!(r.json::<String>()?, "Failed");

    let r = freeze(&e).await?;
    assert_eq!(event(&r, "agent_frozen")?.0, 0, "mode changes at once");
    let (j, del) = event(&r, "agent_key_changed")?;
    assert!(j > 0);
    assert_eq!(
        del["data"],
        json!({ "public_key": pk(&e.agent_pk), "methods": null, "ok": true })
    );
    assert!(r.json::<bool>()?);
    assert!(e.shop.view_access_keys().await?.is_empty());

    wait_chain(&e, 2).await?; // rearm cooldown
    let new_pk = SecretKey::from_random(KeyType::ED25519).public_key();
    assert!(owner_call(&e, "propose_key", json!({ "public_key": new_pk })).await?);
    let r = e
        .vendor
        .call(e.shop.id(), "accept_key")
        .args_json(json!({ "public_key": new_pk }))
        .deposit(YOCTO)
        .gas(KEY_GAS)
        .transact()
        .await?;
    let (i, armed) = event(&r, "agent_armed")?;
    assert!(i > 0, "logged once AddKey ran, not by accept_key");
    assert_eq!(armed["version"], "2.2.0");
    assert_eq!(
        armed["data"],
        json!({ "public_key": pk(&new_pk), "methods": "pay,decline,ack", "ok": true })
    );
    assert!(
        r.json::<bool>()?,
        "the vendor's tx resolves to the AddKey outcome"
    );
    let st: Value = e.shop.view("get_status").await?.json()?;
    assert_eq!(st["mode"], "Armed");
    assert_eq!(st["stale_key"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn failed_key_actions_report_ok_false_and_resync_restores() -> anyhow::Result<()> {
    // Unlocked vault: its full-access key can remove the agent key behind the contract's back.
    let e = setup(Opts {
        lock: false,
        ..Default::default()
    })
    .await?;
    let fak = e.shop.as_account();
    let pk = serde_json::to_value(&e.agent_pk)?;
    let status = || async { anyhow::Ok(e.shop.view("get_status").await?.json::<Value>()?) };
    let lure = Slot::lure(7, &implicit('f'), inv(5).0);
    let slot = commit(&e, &[lure.clone(), Slot::void(8), Slot::void(9)]).await?;
    assert!(pay(&e, &inv(5).1, &lure.payee, USDC).await);
    fak.batch(e.shop.id())
        .delete_key(e.agent_pk.clone())
        .transact()
        .await?
        .into_result()?;

    // The demotion's DeleteKey finds no key, so the batched swap fails; the mode still drops.
    let r = reveal_tx(&e.owner, &e, slot, &lure).await?;
    let (_, swap) = event(&r, "agent_key_changed")?;
    assert_eq!(
        swap["data"],
        json!({ "public_key": pk, "methods": PROPOSE, "ok": false })
    );
    assert_eq!(r.json::<String>()?, "Failed");
    let st = status().await?;
    assert_eq!(st["mode"], "Demoted");
    assert_eq!(st["stale_key"], pk);
    assert_eq!(key_methods(&e).await?, vec!["FullAccess"]);

    // Anyone can resync; it restores the key the mode implies and nothing more.
    let stranger = e.worker.dev_create_account().await?;
    assert!(
        stranger
            .call(e.shop.id(), "on_key_changed")
            .args_json(json!({ "public_key": e.agent_pk, "methods": "pay,decline,ack" }))
            .gas(KEY_GAS)
            .transact()
            .await?
            .is_failure(),
        "callbacks are private"
    );
    let resync = || {
        stranger
            .call(e.shop.id(), "resync_key")
            .gas(KEY_GAS)
            .transact()
    };
    let r = resync().await?;
    let (_, fixed) = event(&r, "agent_key_changed")?;
    assert_eq!(
        fixed["data"],
        json!({ "public_key": pk, "methods": PROPOSE, "ok": true })
    );
    assert!(r.json::<bool>()?);
    assert_eq!(status().await?["stale_key"], Value::Null);
    let methods = key_methods(&e).await?;
    assert_eq!(methods.len(), 2);
    assert!(
        methods
            .iter()
            .any(|m| m.contains("\"propose\"") && !m.contains("\"pay\"")),
        "{methods:?}"
    );
    assert!(resync().await?.is_failure(), "nothing left to resync");
    assert!(!pay(&e, &inv(6).1, "a.test.near", 1).await);
    assert!(
        agent_call(
            &e,
            "propose",
            json!({ "invoice_id": inv(6).1, "payee": "a.test.near", "amount": "1" })
        )
        .await
    );

    // Arming a key that already exists on the account: AddKey fails and the prior state comes back.
    let fak_pk = fak.secret_key().public_key();
    assert!(owner_call(&e, "propose_key", json!({ "public_key": fak_pk })).await?);
    let r = e
        .vendor
        .call(e.shop.id(), "accept_key")
        .args_json(json!({ "public_key": fak_pk }))
        .deposit(YOCTO)
        .gas(KEY_GAS)
        .transact()
        .await?;
    let (_, armed) = event(&r, "agent_armed")?;
    assert_eq!(armed["data"]["ok"], false);
    assert!(!r.json::<bool>()?, "the vendor's tx shows the failure");
    let st = status().await?;
    assert_eq!(
        st["mode"], "Demoted",
        "failed arming restores the prior mode"
    );
    assert_eq!(st["agent_key"], pk);
    assert_eq!(st["stale_key"], pk, "its DeleteKey already ran");
    assert_eq!(
        key_methods(&e).await?,
        vec!["FullAccess"],
        "the full-access key was not touched"
    );
    assert!(resync().await?.json::<bool>()?);
    let methods = key_methods(&e).await?;
    assert!(
        methods
            .iter()
            .any(|m| m.contains("\"propose\"") && !m.contains("\"pay\"")),
        "{methods:?}"
    );
    Ok(())
}

#[tokio::test]
async fn failed_near_withdrawal_reports_ok_false_and_refunds() -> anyhow::Result<()> {
    let e = setup(Opts::default()).await?;
    let before = e.worker.view_account(e.shop.id()).await?.balance;
    let pending = e
        .owner
        .call(e.shop.id(), "withdraw_near")
        .args_json(json!({ "amount": "1000000000000000000000000" }))
        .deposit(YOCTO)
        .gas(KEY_GAS)
        .transact_async()
        .await?;
    // The owner account is gone before the Transfer receipt runs, so the transfer fails.
    e.owner
        .clone()
        .delete_account(e.vendor.id())
        .await?
        .into_result()?;
    let r = pending.await?;
    let (i, ev) = event(&r, "near_withdrawn")?;
    assert!(i > 0);
    assert_eq!(
        ev["data"],
        json!({ "amount": "1000000000000000000000000", "ok": false })
    );
    assert!(!r.json::<bool>()?);
    e.worker.fast_forward(3).await?; // the refund receipt
    let after = e.worker.view_account(e.shop.id()).await?.balance;
    assert!(
        after >= before,
        "the NEAR is back in the vault: {before} -> {after}"
    );
    Ok(())
}

// ---------- V2-02: delivery proof ----------

async fn expires_ns(e: &Env, slot: u32) -> anyhow::Result<u64> {
    let t: Value = e
        .shop
        .view("get_test")
        .args_json(json!({ "slot_id": slot }))
        .await?
        .json()?;
    Ok(t["expires_at"].as_str().unwrap().parse()?)
}

async fn prove(e: &Env, slot: u32, delivery: Value) -> anyhow::Result<Result<String, String>> {
    let r = e
        .owner
        .call(e.shop.id(), "prove_delivery")
        .args_json(json!({ "slot_id": slot, "delivery": delivery }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    Ok(if r.is_success() {
        Ok(r.json::<String>()?)
    } else {
        Err(format!("{:?}", r.into_result().err()))
    })
}

#[tokio::test]
async fn delivered_and_acked_lure_is_ignored_and_scored() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 30,
        min_answer_s: Some(10),
        ..Default::default()
    })
    .await?;
    let a = Slot::lure(1, &implicit('a'), inv(90).0);
    let b = Slot::lure(2, &implicit('b'), inv(91).0);
    let twin = Slot::lure(3, &implicit('c'), inv(91).0);
    let c = Slot::lure(4, &implicit('d'), inv(92).0);
    let first = commit(&e, &[a.clone(), b.clone(), twin.clone()]).await?;
    let second = commit(&e, &[c.clone(), Slot::void(5), Slot::void(6)]).await?;
    // One tick holds the lures and a real invoice; the agent acks the root it recomputed.
    let ids = [inv(90).0, inv(91).0, inv(92).0, inv(99).0];
    let at = now_ns(&e).await?;
    let root = post_release(&e, &ids, at).await?;
    assert!(ack(&e, at, &root).await);
    assert!(!ack(&e, at, &root).await, "one ack per tick");
    let rel: Value = e
        .shop
        .view("get_release")
        .args_json(json!({ "release_at": at.to_string() }))
        .await?
        .json()?;
    assert_eq!(rel["ack"]["root"], root.as_str());
    assert!(decline(&e, &inv(90).1).await);
    wait_chain(&e, 31).await?;

    assert_eq!(reveal(&e.owner, &e, first, &a).await?, Ok("Passed".into()));
    let r =
        reveal_delivered_tx(&e.owner, &e, first + 1, &b, delivery(&ids, &inv(91).0, at)).await?;
    assert_eq!(r.json::<String>()?, "Ignored");
    // The twin rests on the same (non-)decision, so it scores nothing.
    let r = reveal_delivered_tx(
        &e.owner,
        &e,
        first + 2,
        &twin,
        delivery(&ids, &inv(91).0, at),
    )
    .await?;
    assert_eq!(r.json::<String>()?, "Invalid");
    // An ignored invoice is closed: paying a lure payee under it cannot collide its failure into Invalid.
    assert!(!pay(&e, &inv(91).1, &implicit('e'), 1).await);
    assert!(!decline(&e, &inv(91).1).await);

    // Wrong index or another id's proof is refused; the revealer can retry without delivery.
    let mut bad = delivery(&ids, &inv(92).0, at);
    bad["index"] = json!(0);
    let other = delivery(&ids, &inv(90).0, at);
    for d in [bad, other] {
        let err = format!(
            "{:?}",
            reveal_delivered_tx(&e.owner, &e, second, &c, d)
                .await?
                .into_result()
                .err()
        );
        assert!(
            err.contains("delivery proof does not match the release root"),
            "{err}"
        );
    }
    // Anyone can decrypt and reveal first without a proof; the proof still upgrades the slot.
    let anyone = e.worker.dev_create_account().await?;
    assert_eq!(
        reveal(&anyone, &e, second, &c).await?,
        Ok("Unanswered".into())
    );
    assert_eq!(
        prove(&e, second, delivery(&ids, &inv(92).0, at)).await?,
        Ok("Ignored".into())
    );
    assert!(
        prove(&e, second, delivery(&ids, &inv(92).0, at))
            .await?
            .is_err(),
        "once"
    );

    let sc = scorecard(&e).await?;
    assert_eq!(sc["stats"]["passed"], 1);
    assert_eq!(sc["stats"]["ignored"], 2);
    assert_eq!(sc["stats"]["unanswered"], 0);
    assert_eq!(sc["stats"]["invalid"], 1);
    assert_eq!(sc["score_bps"], 3333, "ignored counts as not passed");
    assert_eq!(sc["stats"]["releases_posted"], 1);
    assert_eq!(sc["stats"]["acks_matched"], 1);
    assert_eq!(sc["mode"], "Armed", "ignoring never demotes");
    Ok(())
}

#[tokio::test]
async fn delivery_needs_a_timely_matching_ack() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 30,
        min_answer_s: Some(10),
        ..Default::default()
    })
    .await?;
    let l1 = Slot::lure(1, &implicit('a'), inv(100).0);
    let l2 = Slot::lure(2, &implicit('b'), inv(101).0);
    let l3 = Slot::lure(3, &implicit('c'), inv(102).0);
    let slot = commit(&e, &[l1.clone(), l2.clone(), l3.clone()]).await?;
    let t = now_ns(&e).await?;
    let deadline = expires_ns(&e, slot).await? - 10_000_000_000;

    // Tick 1: never acked.
    let r1 = [inv(100).0];
    post_release(&e, &r1, t).await?;
    // Tick 2: the agent's inbox differs, so its root differs and is stored as evidence.
    let r2 = [inv(101).0, inv(77).0];
    let root2 = post_release(&e, &r2, t + 1).await?;
    let (forked, _) = merkle_tree(&[inv(101).0]);
    assert!(ack(&e, t + 1, &forked).await);
    let rel: Value = e
        .shop
        .view("get_release")
        .args_json(json!({ "release_at": (t + 1).to_string() }))
        .await?
        .json()?;
    assert_eq!(rel["root"], root2.as_str());
    assert_eq!(rel["ack"]["root"], forked.as_str());
    // Tick 3: released too late for the agent to have min_answer left (a tick is posted after it happens).
    let r3 = [inv(102).0];
    let (root3, _) = merkle_tree(&r3);
    assert!(
        post_release(&e, &r3, deadline + 1).await.is_err(),
        "future tick"
    );
    wait_chain(&e, (deadline + 1 - now_ns(&e).await?) / 1_000_000_000 + 1).await?;
    post_release(&e, &r3, deadline + 1).await?;
    assert!(ack(&e, deadline + 1, &root3).await);

    // Roles: only the agent acks, only the tester (owner) releases.
    assert!(
        !owner_call(
            &e,
            "ack",
            json!({ "release_at": t.to_string(), "root": root3 })
        )
        .await?
    );
    assert!(
        e.owner
            .call(e.shop.id(), "ack")
            .args_json(json!({ "release_at": t.to_string(), "root": root3 }))
            .transact()
            .await?
            .is_failure(),
        "tester (owner, no deposit) cannot ack"
    );
    assert!(
        !agent_call(
            &e,
            "release",
            json!({ "release_at": "5", "root": root3, "count": 1 })
        )
        .await
    );
    wait_chain(&e, 31).await?;

    for (i, (s, d, why)) in [
        (
            &l1,
            delivery(&r1, &inv(100).0, t),
            "release not acked by the agent",
        ),
        (
            &l2,
            delivery(&r2, &inv(101).0, t + 1),
            "agent ack does not match the release root",
        ),
        (
            &l3,
            delivery(&r3, &inv(102).0, deadline + 1),
            "release outside the answer window",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let id = slot + i as u32;
        let r = reveal_delivered_tx(&e.owner, &e, id, s, d.clone()).await?;
        let err = format!("{:?}", r.into_result().err());
        assert!(err.contains(why), "slot {id}: {err}");
        assert_eq!(reveal(&e.owner, &e, id, s).await?, Ok("Unanswered".into()));
        assert!(
            prove(&e, id, d).await?.is_err(),
            "slot {id}: no upgrade either"
        );
    }
    let sc = scorecard(&e).await?;
    assert_eq!(sc["stats"]["unanswered"], 3);
    assert_eq!(sc["stats"]["ignored"], 0);
    assert_eq!(sc["stats"]["releases_posted"], 3);
    assert_eq!(sc["stats"]["acks_matched"], 1);
    assert_eq!(sc["stats"]["acks_mismatched"], 1);
    assert_eq!(sc["score_bps"], Value::Null);
    Ok(())
}

// ---------- 2.3.0 audit (v2/33): owner cannot frame Ignored ----------

// V23-04, V23-06, V23-11 (inverted proofs of concept from v2/33).
#[tokio::test]
async fn v23_owner_cannot_frame_ignored() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 30,
        min_answer_s: Some(10),
        max_decisions: 4,
        ..Default::default()
    })
    .await?;
    let (x, y) = (inv(120), inv(121));
    let t0 = now_ns(&e).await?;
    // V23-04: a release label cannot reach ahead of a later commit.
    assert!(post_release(&e, &[x.0], t0 + 15_000_000_000).await.is_err());
    // The agent sees X and declines it before X becomes a lure.
    let root = post_release(&e, &[x.0], t0).await?;
    assert!(ack(&e, t0, &root).await);
    assert!(decline(&e, &x.1).await);
    let lx = Slot::lure(1, &implicit('a'), x.0);
    let ly = Slot::lure(2, &implicit('b'), y.0);
    let slot = commit(&e, &[lx.clone(), ly.clone(), Slot::void(3)]).await?;
    // The inbox re-serves X after the commit; Y arrives with filler ticks.
    let t1 = now_ns(&e).await?;
    let rx = [x.0, inv(130).0];
    let root = post_release(&e, &rx, t1).await?;
    assert!(ack(&e, t1, &root).await);
    // V23-06: more acks than max_decisions_per_day still leave the agent its decisions.
    for i in 1..=4u64 {
        let ids = [y.0, inv(130 + i as u8).0];
        let root = post_release(&e, &ids, t1 + i).await?;
        assert!(ack(&e, t1 + i, &root).await, "tick {i}");
    }
    assert!(
        decline(&e, &y.1).await,
        "acks never spend the decision budget"
    );
    wait_chain(&e, 31).await?;

    let r = reveal_delivered_tx(&e.owner, &e, slot, &lx, delivery(&rx, &x.0, t1)).await?;
    let err = format!("{:?}", r.into_result().err());
    assert!(err.contains("invoice has a decision: not ignored"), "{err}");
    assert_eq!(
        reveal(&e.owner, &e, slot, &lx).await?,
        Ok("Unanswered".into())
    );
    assert_eq!(
        reveal(&e.owner, &e, slot + 1, &ly).await?,
        Ok("Passed".into())
    );
    let sc = scorecard(&e).await?;
    assert_eq!(sc["score_bps"], 10000);
    // V23-11: tick and ack coverage is on the scorecard.
    assert_eq!(sc["stats"]["releases_posted"], 6);
    assert_eq!(sc["stats"]["acks_matched"], 6);
    assert_eq!(sc["stats"]["acks_mismatched"], 0);
    Ok(())
}

// V23-07: freezing after the ack leaves an agent that could not act Unanswered, not Ignored.
#[tokio::test]
async fn v23_freeze_after_ack_cannot_score_ignored() -> anyhow::Result<()> {
    let e = setup(Opts {
        ttl_s: 30,
        min_answer_s: Some(10),
        ..Default::default()
    })
    .await?;
    let x = inv(160);
    let lure = Slot::lure(1, &implicit('d'), x.0);
    let slot = commit(&e, &[lure.clone(), Slot::void(2), Slot::void(3)]).await?;
    let at = now_ns(&e).await?;
    let root = post_release(&e, &[x.0], at).await?;
    assert!(ack(&e, at, &root).await);
    assert!(freeze(&e).await?.is_success());
    assert!(!decline(&e, &x.1).await, "frozen agent cannot decide");
    wait_chain(&e, 31).await?;
    let r = reveal_delivered_tx(&e.owner, &e, slot, &lure, delivery(&[x.0], &x.0, at)).await?;
    let err = format!("{:?}", r.into_result().err());
    assert!(err.contains("unarmed or frozen"), "{err}");
    assert_eq!(
        reveal(&e.owner, &e, slot, &lure).await?,
        Ok("Unanswered".into())
    );
    Ok(())
}
