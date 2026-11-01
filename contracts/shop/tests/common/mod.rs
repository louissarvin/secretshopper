// Shared sandbox helpers for tests/sandbox.rs and tests/costs.rs.
#![allow(dead_code)]
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, PublicKey, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const USDC: u128 = 1_000_000;
pub const YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const DRAND_GENESIS_S: u64 = 1_692_803_367;
pub const RECEIPT: [u8; 32] = [0x5e; 32];
pub const NO_RECEIPT: [u8; 32] = [0; 32];

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub shop: Contract,
    pub ft: Contract,
    pub owner: Account,
    pub vendor: Account,
    pub agent: Account, // the vault account id, signed with the agent FC key
    pub agent_pk: PublicKey,
}

pub struct Opts {
    pub ttl_s: u64,
    pub cooldown_s: u64,
    /// Delete the vault's full-access key (`e.shop.as_account()` signs with it while unlocked).
    pub lock: bool,
    /// Policy `min_answer` in seconds; None is test_ttl / 4, the contract's floor.
    pub min_answer_s: Option<u64>,
    pub max_decisions: u32,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            ttl_s: 60,
            cooldown_s: 1,
            lock: true,
            min_answer_s: None,
            max_decisions: 50,
        }
    }
}

/// Gas for owner and vendor calls that schedule a key or transfer callback.
pub const KEY_GAS: Gas = Gas::from_tgas(50);

pub fn policy(o: &Opts) -> Value {
    let s = |x: u64| (x * 1_000_000_000).to_string();
    json!({
        "daily_cap": (5 * USDC).to_string(), "max_per_payment": (2 * USDC).to_string(),
        "max_new_payees_per_day": 5, "max_payments_per_day": 20, "max_decisions_per_day": o.max_decisions,
        "batch_size": 3, "batch_interval": "1", "test_ttl": s(o.ttl_s),
        "reveal_grace": s(10), "rearm_cooldown": s(o.cooldown_s),
        "payee_delay": "0", "limits_delay": s(3600),
        "key_allowance": "250000000000000000000000", "storage_deposit": "1250000000000000000000",
        "min_near_float": "500000000000000000000000", "min_answer": o.min_answer_s.map_or((o.ttl_s * 1_000_000_000 / 4).to_string(), s)
    })
}

pub fn commitment(salt: &[u8; 32], payee: &str, invoice: &[u8; 32], receipt: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(salt);
    h.update([payee.len() as u8]);
    h.update(payee.as_bytes());
    h.update(invoice);
    h.update(receipt);
    hex::encode(h.finalize())
}

pub fn inv(n: u8) -> ([u8; 32], String) {
    let b = [n; 32];
    (b, hex::encode(b))
}

pub fn implicit(c: char) -> String {
    c.to_string().repeat(64)
}

#[derive(Clone)]
pub struct Slot {
    pub salt: [u8; 32],
    pub payee: String,
    pub invoice: [u8; 32],
    pub receipt: [u8; 32],
}

impl Slot {
    pub fn lure(seed: u8, payee: &str, invoice: [u8; 32]) -> Self {
        Self {
            salt: [seed; 32],
            payee: payee.into(),
            invoice,
            receipt: RECEIPT,
        }
    }
    pub fn void(seed: u8) -> Self {
        Self {
            salt: [seed; 32],
            payee: String::new(),
            invoice: [seed; 32],
            receipt: NO_RECEIPT,
        }
    }
    pub fn commitment(&self) -> String {
        commitment(&self.salt, &self.payee, &self.invoice, &self.receipt)
    }
}

pub async fn setup(o: Opts) -> anyhow::Result<Env> {
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
    shop.call("new")
        .args_json(json!({
            "owner_id": owner.id(), "vendor_id": vendor.id(), "token_id": ft.id(),
            "intents_id": null, "policy": policy(&o)
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

    if o.lock {
        // Lock: remove the vault's only full-access key.
        let fak = shop_acc.secret_key().public_key();
        shop_acc
            .batch(shop.id())
            .delete_key(fak)
            .transact()
            .await?
            .into_result()?;
    }

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

pub async fn arm(
    owner: &Account,
    vendor: &Account,
    shop: &Contract,
    pk: &PublicKey,
) -> anyhow::Result<()> {
    owner
        .call(shop.id(), "propose_key")
        .args_json(json!({ "public_key": pk }))
        .deposit(YOCTO)
        .transact()
        .await?
        .into_result()?;
    let r = vendor
        .call(shop.id(), "accept_key")
        .args_json(json!({ "public_key": pk }))
        .deposit(YOCTO)
        .gas(KEY_GAS)
        .transact()
        .await?
        .into_result()?;
    anyhow::ensure!(r.json::<bool>()?, "AddKey failed: {:?}", r.logs());
    Ok(())
}

pub async fn freeze(e: &Env) -> anyhow::Result<ExecutionFinalResult> {
    Ok(e.owner
        .call(e.shop.id(), "freeze")
        .deposit(YOCTO)
        .gas(KEY_GAS)
        .transact()
        .await?)
}

/// NEP-297 events per receipt outcome as (receipt index, event); index 0 is the called method's receipt.
pub fn events(r: &ExecutionFinalResult) -> Vec<(usize, Value)> {
    r.receipt_outcomes()
        .iter()
        .enumerate()
        .flat_map(|(i, o)| {
            o.logs.iter().filter_map(move |l| {
                let mut ev: Value = serde_json::from_str(l.strip_prefix("EVENT_JSON:")?).ok()?;
                if let Some(d) = ev["data"].as_array().and_then(|a| a.first()).cloned() {
                    ev["data"] = d;
                }
                Some((i, ev))
            })
        })
        .collect()
}

/// The single `name` event in `r`: (receipt index, event).
pub fn event(r: &ExecutionFinalResult, name: &str) -> anyhow::Result<(usize, Value)> {
    let mut found: Vec<_> = events(r)
        .into_iter()
        .filter(|(_, e)| e["event"] == name)
        .collect();
    anyhow::ensure!(found.len() == 1, "expected one {name} event, got {found:?}");
    Ok(found.remove(0))
}

pub async fn agent_call(e: &Env, method: &str, args: Value) -> bool {
    let r = e
        .agent
        .call(e.shop.id(), method)
        .args_json(args)
        .gas(Gas::from_tgas(80))
        .transact()
        .await;
    matches!(r, Ok(ref x) if x.is_success())
}

pub async fn pay(e: &Env, invoice_id: &str, payee: &str, amount: u128) -> bool {
    agent_call(
        e,
        "pay",
        json!({ "invoice_id": invoice_id, "payee": payee, "amount": amount.to_string() }),
    )
    .await
}

pub async fn decline(e: &Env, invoice_id: &str) -> bool {
    agent_call(
        e,
        "decline",
        json!({ "invoice_id": invoice_id, "reason": "payee not on vendor record" }),
    )
    .await
}

pub async fn now_s(e: &Env) -> anyhow::Result<u64> {
    let sc: Value = e.shop.view("get_scorecard").await?.json()?;
    Ok(sc["now"].as_str().unwrap().parse::<u64>()? / 1_000_000_000)
}

pub const DRAND_QUICKNET: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/// A tlock age file for `round` (real header, filler body, 871 bytes like a sealed preimage): base64 and sha256 hex.
pub fn ciphertext_for(round: u64, tag: u8) -> (Value, String) {
    let mut b = format!("age-encryption.org/v1\n-> tlock {round} {DRAND_QUICKNET}\n").into_bytes();
    b.resize(871, tag);
    let sha = hex::encode(Sha256::digest(&b));
    (
        serde_json::to_value(near_sdk::json_types::Base64VecU8::from(b)).unwrap(),
        sha,
    )
}

/// commit_batch args for `slots` at `round`, each with a valid ciphertext.
pub fn batch_args(slots: &[Slot], round: u64) -> Value {
    let (input, cts): (Vec<Value>, Vec<Value>) = slots
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let (ct, sha) = ciphertext_for(round, i as u8);
            (json!({ "commitment": s.commitment(), "tlock_round": round, "ciphertext_sha256": sha }), ct)
        })
        .unzip();
    json!({ "slots": input, "ciphertexts": cts })
}

pub async fn commit(e: &Env, slots: &[Slot]) -> anyhow::Result<u32> {
    // A drand round about 3 s before expiry: it opens after the commit and before expiry.
    let policy: Value = e.shop.view("get_policy").await?.json()?;
    let ttl: u64 = policy["test_ttl"].as_str().unwrap().parse::<u64>()? / 1_000_000_000;
    // First drand round after expiry: the lure cannot be decrypted while it still counts.
    let round = (now_s(e).await? + ttl + 2 - DRAND_GENESIS_S) / 3 + 2;
    Ok(e.owner
        .call(e.shop.id(), "commit_batch")
        .args_json(batch_args(slots, round))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

pub async fn reveal_tx(
    by: &Account,
    e: &Env,
    slot_id: u32,
    s: &Slot,
) -> anyhow::Result<ExecutionFinalResult> {
    reveal_delivered_tx(by, e, slot_id, s, Value::Null).await
}

/// `reveal` with a `delivery` argument (`Value::Null` for none).
pub async fn reveal_delivered_tx(
    by: &Account,
    e: &Env,
    slot_id: u32,
    s: &Slot,
    delivery: Value,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(by
        .call(e.shop.id(), "reveal")
        .args_json(json!({
            "slot_id": slot_id, "salt": hex::encode(s.salt), "payee": s.payee,
            "invoice_id": hex::encode(s.invoice), "receipt_hash": hex::encode(s.receipt),
            "delivery": delivery
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

pub async fn reveal(
    by: &Account,
    e: &Env,
    slot_id: u32,
    s: &Slot,
) -> anyhow::Result<Result<String, String>> {
    let r = reveal_tx(by, e, slot_id, s).await?;
    if r.is_success() {
        println!("reveal logs: {:?}", r.logs());
        Ok(Ok(r.json::<String>()?))
    } else {
        Ok(Err(format!("{:?}", r.into_result().err())))
    }
}

pub async fn scorecard(e: &Env) -> anyhow::Result<Value> {
    Ok(e.shop.view("get_scorecard").await?.json()?)
}

pub async fn key_methods(e: &Env) -> anyhow::Result<Vec<String>> {
    let keys = e.shop.view_access_keys().await?;
    Ok(keys
        .iter()
        .map(|k| format!("{:?}", k.access_key.permission))
        .collect())
}

// Fast-forward until chain time passes `secs` from now.
pub async fn wait_chain(e: &Env, secs: u64) -> anyhow::Result<()> {
    let start = now_s(e).await?;
    for _ in 0..80 {
        e.worker.fast_forward(100).await?;
        if now_s(e).await? >= start + secs {
            return Ok(());
        }
    }
    anyhow::bail!("chain time did not advance {secs}s")
}

pub async fn owner_tx(e: &Env, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(e.owner
        .call(e.shop.id(), method)
        .args_json(args)
        .deposit(YOCTO)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

pub async fn owner_call(e: &Env, method: &str, args: Value) -> anyhow::Result<bool> {
    Ok(owner_tx(e, method, args).await?.is_success())
}

fn merkle_leaf(id: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([0u8]);
    h.update(id);
    h.finalize().into()
}

fn merkle_node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([1u8]);
    h.update(l);
    h.update(r);
    h.finalize().into()
}

/// Release tree over `ids`: (root hex, sorted ids) with sorted, zero-padded leaves.
pub fn merkle_tree(ids: &[[u8; 32]]) -> (String, Vec<[u8; 32]>) {
    let mut sorted = ids.to_vec();
    sorted.sort();
    let mut level: Vec<[u8; 32]> = sorted.iter().map(merkle_leaf).collect();
    level.resize(level.len().next_power_of_two(), [0u8; 32]);
    while level.len() > 1 {
        level = level.chunks(2).map(|p| merkle_node(&p[0], &p[1])).collect();
    }
    (hex::encode(level[0]), sorted)
}

/// Delivery argument for `id` in the release of `ids` at `release_at` ns.
pub fn delivery(ids: &[[u8; 32]], id: &[u8; 32], release_at: u64) -> Value {
    let mut sorted = ids.to_vec();
    sorted.sort();
    let index = sorted
        .iter()
        .position(|x| x == id)
        .expect("id in the release");
    let mut level: Vec<[u8; 32]> = sorted.iter().map(merkle_leaf).collect();
    level.resize(level.len().next_power_of_two(), [0u8; 32]);
    let mut proof = Vec::new();
    let mut i = index;
    while level.len() > 1 {
        proof.push(hex::encode(level[i ^ 1]));
        level = level.chunks(2).map(|p| merkle_node(&p[0], &p[1])).collect();
        i >>= 1;
    }
    json!({ "release_at": release_at.to_string(), "index": index, "proof": proof })
}

/// Chain time in ns.
pub async fn now_ns(e: &Env) -> anyhow::Result<u64> {
    let sc: Value = e.shop.view("get_scorecard").await?.json()?;
    Ok(sc["now"].as_str().unwrap().parse::<u64>()?)
}

/// Tester posts the release of `ids` at `release_at`; returns the root.
pub async fn post_release(e: &Env, ids: &[[u8; 32]], release_at: u64) -> anyhow::Result<String> {
    let (root, _) = merkle_tree(ids);
    e.owner
        .call(e.shop.id(), "release")
        .args_json(
            json!({ "release_at": release_at.to_string(), "root": root, "count": ids.len() }),
        )
        .transact()
        .await?
        .into_result()?;
    Ok(root)
}

pub async fn ack(e: &Env, release_at: u64, root: &str) -> bool {
    agent_call(
        e,
        "ack",
        json!({ "release_at": release_at.to_string(), "root": root }),
    )
    .await
}
