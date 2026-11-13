use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Allowance, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_STORAGE: Gas = Gas::from_tgas(10);
const GAS_FT: Gas = Gas::from_tgas(15);
const GAS_FT_CALL: Gas = Gas::from_tgas(100); // Intents deposits doc: 100 Tgas covers a simple deposit
const GAS_CB: Gas = Gas::from_tgas(10);
const DAY_NS: u64 = 86_400_000_000_000;
// Never grant callbacks to an FC key on this account: #[private] only checks predecessor == self.
pub const PAY_METHODS: &str = "pay,decline,ack";
pub const PROPOSE_METHODS: &str = "propose,decline,ack";
const MAX_REASON: usize = 140;
const MAX_LABEL: usize = 64;
const REVEAL_BYTES: u128 = 600; // a scored reveal with demotion stores 549 B (measured cost profile)
const FLUSH_MARGIN_BYTES: u128 = 2_000; // collections flush after the float check runs (V21-02)
                                        // drand quicknet (https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info)
pub const DRAND_GENESIS_S: u64 = 1_692_803_367;
pub const DRAND_PERIOD_S: u64 = 3;
// Gas per arming or demotion grows with lanes (V23-09: 1024 lanes burn about 80 Tgas); one agent needs few.
pub const MAX_KEY_NONCES: u32 = 64;
// One ack per 30 min; acks have their own budget so ticks cannot spend the agent's decisions (V23-06).
pub const MAX_ACKS_PER_DAY: usize = 48;
// Gas-key storage bound: per lane trie key (pk + u32) + u64 nonce + 40 B record; base covers the key record.
const GAS_KEY_LANE_EXTRA_BYTES: u128 = 4 + 8 + 40;
const GAS_KEY_BASE_BYTES: u128 = 300;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> U128;
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Tests,
    Batches,
    Commitments,
    Decisions,
    Payments,
    Proposals,
    Payees,
    Approved,
    ScoredDecisions,
    Paid,
    Registered,
    Releases,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Unarmed,
    Armed,
    Demoted,
    Frozen,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rail {
    Near,
    Intents,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TestStatus {
    Committed,
    Passed,
    Failed,
    Unanswered,
    Void,
    Invalid,
    // The agent paid or proposed the lure invoice to another payee: shown, never scored or demoting,
    // because the owner sees real invoice ids first and could otherwise frame a legitimate payment.
    Misdirected,
    // Undecided, but proven delivered and acked in time (V2-02): scored as not passed, never demoting.
    Ignored,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DecisionKind {
    Paid,
    Declined,
    Proposed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TxStatus {
    Pending,
    Settled,
    Failed,
    Approved,
    Rejected,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    pub daily_cap: U128, // token base units, rolling 24 h
    pub max_per_payment: U128,
    pub max_new_payees_per_day: u32,
    pub max_payments_per_day: u32,
    pub max_decisions_per_day: u32,
    pub batch_size: u32,     // K slots per batch, tests + voids
    pub batch_interval: U64, // ns
    pub test_ttl: U64,       // ns from commit to expiry
    pub reveal_grace: U64,   // ns after expiry before a slot counts as overdue
    pub rearm_cooldown: U64, // ns after demotion
    pub payee_delay: U64,    // ns before an approved payee becomes active
    pub limits_delay: U64,   // ns before loosened limits apply
    pub key_allowance: NearToken,
    pub storage_deposit: NearToken, // token storage_balance_bounds.min
    pub min_near_float: NearToken,  // NEAR the owner can never withdraw
    /// 0: classic FC key with `key_allowance`. 1..=MAX_KEY_NONCES (64): FC gas key with this many nonce lanes,
    /// funded with `key_allowance` on every add.
    #[serde(default)]
    pub key_nonces: u32,
    /// ns the agent must have had between an acked release and expiry; at least test_ttl / 4.
    #[serde(default)]
    pub min_answer: U64,
}

/// One inbox release tick: the tester's Merkle root over every released invoice id.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Release {
    pub root: String,
    pub count: u32,
    pub at: U64,
    pub ack: Option<Ack>,
}

/// The agent's root for a tick, stored whatever it is: a mismatch is evidence of a forked inbox.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Ack {
    pub root: String,
    pub at: U64,
    pub key: PublicKey,
}

/// Inclusion proof of a lure's invoice id in the release at `release_at`.
#[near(serializers = [json])]
pub struct Delivery {
    pub release_at: U64,
    pub index: u32,
    pub proof: Vec<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Limits {
    pub daily_cap: U128,
    pub max_per_payment: U128,
    pub max_new_payees_per_day: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PendingLimits {
    pub limits: Limits,
    pub effective_at: U64,
}

#[near(serializers = [json])]
pub struct SlotInput {
    pub commitment: String,
    pub tlock_round: u64,
    pub ciphertext_sha256: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Reveal {
    pub payee: String,
    pub invoice_id: String,
    pub receipt_hash: String,
    pub salt: String,
    pub at: U64,
    pub by: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TestSlot {
    pub commitment: String,
    pub batch: u32,
    pub committed_at: U64,
    pub expires_at: U64,
    pub tlock_round: u64,
    pub ciphertext_sha256: String,
    pub status: TestStatus,
    pub contained: bool,
    pub demoted: bool,
    pub reveal: Option<Reveal>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Batch {
    pub first_slot: u32,
    pub count: u32,
    pub committed_at: U64,
    pub expires_at: U64,
    pub unrevealed: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Decision {
    pub kind: DecisionKind,
    pub payee: Option<AccountId>,
    pub payee_approved: bool,
    pub amount: U128,
    pub at: U64,
    pub key: PublicKey,
    pub ref_id: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Payment {
    pub invoice_id: String,
    pub payee: AccountId,
    pub amount: U128,
    pub rail: Rail,
    pub status: TxStatus,
    pub by_owner: bool,
    pub at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Proposal {
    pub invoice_id: String,
    pub payee: AccountId,
    pub amount: U128,
    pub rail: Rail,
    pub status: TxStatus,
    pub at: U64,
}

/// First time the vault touched a payee; a record made while listed gives way to the first unlisted touch (V2-08).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PayeeSeen {
    pub at: U64,
    /// The decision behind `at`: a touched lure scores against this decision.
    pub invoice_id: String,
    pub via_proposal: bool,
    /// True while every touch so far was made while the payee was listed.
    pub approved: bool,
    pub key: Option<PublicKey>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ApprovedPayee {
    pub label: String,
    pub active_at: U64,
    /// Delisting also waits `payee_delay`, so the owner cannot pull a payee out from under a payment.
    pub removed_at: Option<U64>,
}

#[near(serializers = [json])]
pub struct ApprovedPayeeView {
    pub account_id: AccountId,
    pub label: String,
    pub active_at: U64,
    pub removed_at: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy)]
struct SpendMark {
    at: u64,
    amount: u128,
    // first payment to an unlisted payee; counted against max_new_payees_per_day in the same rolling 24 h
    new_payee: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Stats {
    pub committed: u32,
    pub passed: u32,
    pub failed: u32,
    pub failed_contained: u32,
    pub unanswered: u32,
    pub void: u32,
    pub invalid: u32,
    pub misdirected: u32,
    pub ignored: u32,
    pub releases_posted: u32,
    pub acks_matched: u32,
    pub acks_mismatched: u32,
    pub payments: u32,
    pub paid_total: U128,
    pub declines: u32,
    pub proposals: u32,
    pub demotions: u32,
}

#[near(serializers = [json])]
pub struct Scorecard {
    pub mode: Mode,
    pub agent_key: Option<PublicKey>,
    pub stats: Stats,
    /// passed / (passed + failed + failed_contained + ignored), in basis points; None before any score
    pub score_bps: Option<u32>,
    pub pending: u32,
    pub overdue_unrevealed: u32,
    pub spent_24h: U128,
    pub now: U64,
}

#[near(serializers = [json])]
pub struct Status {
    pub mode: Mode,
    pub agent_key: Option<PublicKey>,
    pub pending_key: Option<PublicKey>,
    pub armed_at: U64,
    pub demoted_at: U64,
    pub spent_24h: U128,
    pub owner_id: AccountId,
    pub vendor_id: AccountId,
    pub token_id: AccountId,
    pub intents_id: Option<AccountId>,
    pub version: String,
    /// A key whose last change failed; `resync_key` re-applies what `mode` implies.
    pub stale_key: Option<PublicKey>,
}

#[near(event_json(standard = "secret_shopper"))]
pub enum Ev {
    // Only a real `new` execution logs this; verifiers anchor a vault's state to it (V21-04).
    #[event_version("2.1.0")]
    Initialized {
        version: String,
        owner_id: AccountId,
        vendor_id: AccountId,
        token_id: AccountId,
    },
    #[event_version("2.0.0")]
    KeyProposed { public_key: PublicKey },
    /// From the callback once AddKey ran. `ok: false`: no key was added and the prior mode is restored.
    #[event_version("2.2.0")]
    AgentArmed {
        public_key: PublicKey,
        methods: String,
        ok: bool,
    },
    /// Authority is cut here; the key swap reports in `AgentKeyChanged`.
    #[event_version("2.2.0")]
    AgentDemoted { slot_id: u32, public_key: PublicKey },
    #[event_version("2.0.0")]
    AgentFrozen { public_key: Option<PublicKey> },
    /// Key action result. `methods: None` is a deletion; a failed deletion means the key was already gone,
    /// or for a gas key that it holds over 1 NEAR (then `stale_key` is set).
    /// A failed re-scope sets `stale_key` until someone calls `resync_key`.
    #[event_version("2.2.0")]
    AgentKeyChanged {
        public_key: PublicKey,
        methods: Option<String>,
        ok: bool,
    },
    #[event_version("2.0.0")]
    BatchCommitted {
        batch: u32,
        first_slot: u32,
        count: u32,
        expires_at: U64,
    },
    #[event_version("2.0.0")]
    Paid {
        payment_id: u32,
        invoice_id: String,
        payee: AccountId,
        amount: U128,
        rail: Rail,
        by_owner: bool,
    },
    #[event_version("2.0.0")]
    PaymentSettled { payment_id: u32, ok: bool },
    #[event_version("2.0.0")]
    Declined { invoice_id: String, reason: String },
    #[event_version("2.0.0")]
    Proposed {
        proposal_id: u32,
        invoice_id: String,
        payee: AccountId,
        amount: U128,
    },
    #[event_version("2.0.0")]
    ProposalResolved { proposal_id: u32, approved: bool },
    /// A slot can emit this twice: `Unanswered` at reveal, then `Ignored` from `prove_delivery`.
    #[event_version("2.0.0")]
    TestRevealed {
        slot_id: u32,
        status: TestStatus,
        contained: bool,
        payee: String,
        invoice_id: String,
        receipt_hash: String,
    },
    #[event_version("2.0.0")]
    Withdrawn { amount: U128, ok: bool },
    /// From the callback. `ok: false`: the transfer failed and the protocol refunds `amount` to the vault.
    #[event_version("2.2.0")]
    NearWithdrawn { amount: NearToken, ok: bool },
    #[event_version("2.0.0")]
    PayeeAdded {
        account_id: AccountId,
        label: String,
        active_at: U64,
    },
    #[event_version("2.0.0")]
    PayeeRemoved {
        account_id: AccountId,
        removed_at: U64,
    },
    #[event_version("2.0.0")]
    LimitsQueued { limits: Limits, effective_at: U64 },
    #[event_version("2.0.0")]
    LimitsApplied { limits: Limits },
    #[event_version("2.3.0")]
    ReleasePosted {
        release_at: U64,
        root: String,
        count: u32,
    },
    #[event_version("2.3.0")]
    ReleaseAcked { release_at: U64, matches: bool },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Shop {
    owner_id: AccountId,
    vendor_id: AccountId,
    token_id: AccountId,
    intents_id: Option<AccountId>,
    policy: Policy,
    pending_limits: Option<PendingLimits>,
    mode: Mode,
    agent_key: Option<PublicKey>,
    pending_key: Option<PublicKey>,
    armed_at: U64,
    demoted_at: U64,
    spend_window: Vec<SpendMark>,
    day: u64,
    decisions_today: u32,
    last_batch_at: U64,
    stats: Stats,
    tests: Vector<TestSlot>,
    batches: Vector<Batch>,
    commitments: LookupSet<String>,
    decisions: LookupMap<String, Decision>,
    payments: Vector<Payment>,
    proposals: Vector<Proposal>,
    payees: LookupMap<AccountId, PayeeSeen>,
    approved: IterableMap<AccountId, ApprovedPayee>,
    /// Agent decisions (by invoice id) already scored Passed or Failed: each scores once, whatever the reveal order.
    scored_decisions: LookupSet<String>,
    paid: LookupSet<AccountId>,
    registered: LookupSet<AccountId>,
    open_from: u32,
    open_slots: u32, // committed, unrevealed: each reveal needs about REVEAL_BYTES of storage
    stale_key: Option<PublicKey>,
    releases: LookupMap<u64, Release>,
    /// Last `freeze` or failed arming, 0 if never: the agent could not act from then on (V23-07).
    frozen_at: U64,
    /// Ack times in the last 24 h, at most MAX_ACKS_PER_DAY.
    ack_window: Vec<u64>,
}

fn now() -> u64 {
    env::block_timestamp()
}

// Lowercase only: decisions are keyed by this string, so "AB.." and "ab.." must not both exist.
/// drand quicknet chain hash, the network tlock-js `mainnetClient` encrypts to.
pub const DRAND_QUICKNET: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const MAX_CIPHERTEXT: usize = 2048; // a sealed 512-byte preimage is 871 bytes

/// The contract cannot test that a ciphertext decrypts (that needs the future drand signature), but it
/// pins the age header to this round on quicknet and the bytes to the stored hash, so the published
/// file is exactly what keepers will open. A junk body still shows up as sabotage at the round.
fn check_ciphertext(c: &[u8], round: u64, sha: &str) {
    require!(c.len() <= MAX_CIPHERTEXT, "ciphertext too long");
    let header = format!("age-encryption.org/v1\n-> tlock {round} {DRAND_QUICKNET}\n");
    require!(
        c.starts_with(header.as_bytes()),
        "ciphertext is not a tlock age file for this slot's round on drand quicknet"
    );
    require!(
        env::sha256_array(c) == hex32(sha, "ciphertext_sha256"),
        "ciphertext does not match ciphertext_sha256"
    );
}

fn hex32(s: &str, what: &str) -> [u8; 32] {
    require!(
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        format!("{what} must be 64 lowercase hex chars")
    );
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out)
        .unwrap_or_else(|_| env::panic_str(&format!("{what} must be hex")));
    out
}

/// Merkle leaf of an invoice id; the 0x00/0x01 domain bytes keep a leaf from passing as a node.
fn merkle_leaf(invoice_id: &[u8; 32]) -> [u8; 32] {
    let mut b = [0u8; 33];
    b[1..].copy_from_slice(invoice_id);
    env::sha256_array(b)
}

fn merkle_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut b = [0u8; 65];
    b[0] = 1;
    b[1..33].copy_from_slice(left);
    b[33..].copy_from_slice(right);
    env::sha256_array(b)
}

/// ceil(log2(count)) for count >= 1: a tick of one item has depth 0.
fn merkle_depth(count: u32) -> u32 {
    u32::BITS - count.max(1).saturating_sub(1).leading_zeros()
}

/// Root implied by `leaf` at `index` with sibling path `proof` (leaf to root).
fn merkle_root_of(leaf: [u8; 32], mut index: u32, proof: &[[u8; 32]]) -> [u8; 32] {
    proof.iter().fold(leaf, |cur, sib| {
        let node = if index & 1 == 0 {
            merkle_node(&cur, sib)
        } else {
            merkle_node(sib, &cur)
        };
        index >>= 1;
        node
    })
}

/// sha256(salt || u8(len(payee)) || payee || invoice_id || receipt_hash)
pub fn commitment_of(
    salt: &[u8; 32],
    payee: &str,
    invoice: &[u8; 32],
    receipt: &[u8; 32],
) -> [u8; 32] {
    let mut buf = Vec::with_capacity(97 + payee.len());
    buf.extend_from_slice(salt);
    buf.push(payee.len() as u8);
    buf.extend_from_slice(payee.as_bytes());
    buf.extend_from_slice(invoice);
    buf.extend_from_slice(receipt);
    env::sha256_array(&buf)
}

/// Latest drand quicknet round that is public at `t_ns`.
pub fn drand_round_at(t_ns: u64) -> u64 {
    let t = t_ns / 1_000_000_000;
    if t < DRAND_GENESIS_S {
        0
    } else {
        (t - DRAND_GENESIS_S) / DRAND_PERIOD_S + 1
    }
}

#[near]
impl Shop {
    #[init]
    pub fn new(
        owner_id: AccountId,
        vendor_id: AccountId,
        token_id: AccountId,
        intents_id: Option<AccountId>,
        policy: Policy,
    ) -> Self {
        // The vault itself, or its parent in the account-creation tx: with a global contract the vault
        // is created, given code and initialized atomically and never holds a full-access key.
        let me = env::current_account_id();
        let caller = env::predecessor_account_id();
        // V21-03: the parent must sign itself, so a relaying parent (DAO, proxy, factory) cannot init for others.
        require!(
            caller == me
                || (me.get_parent_account_id() == Some(caller.as_ref())
                    && env::signer_account_id() == caller),
            "only the vault or its parent account can initialize"
        );
        // V21-01: a classic key burns at most its allowance from the vault; a gas key is funded with it
        // at each add. Either way the float must cover one re-key at demotion.
        require!(
            policy.key_allowance.saturating_mul(2) <= policy.min_near_float,
            "key_allowance must be at most half of min_near_float"
        );
        if policy.key_nonces > 0 {
            require!(
                policy.key_nonces <= MAX_KEY_NONCES,
                "key_nonces must be at most 64"
            );
            // DeleteKey fails when it would burn more than 1 NEAR from a gas key.
            require!(
                policy.key_allowance <= NearToken::from_near(1),
                "gas key allowance must be at most 1 NEAR"
            );
        }
        require!(policy.batch_size > 0 && policy.test_ttl.0 > 0, "bad policy");
        // V23-05: the owner cannot deliver a lure so late that the agent had no time to answer it.
        require!(
            policy.min_answer.0 >= policy.test_ttl.0 / 4 && policy.min_answer.0 > 0,
            "min_answer must be at least a quarter of test_ttl"
        );
        require!(
            policy.min_answer.0 < policy.test_ttl.0,
            "min_answer must be below test_ttl"
        );
        require!(
            policy.max_payments_per_day > 0 && policy.max_decisions_per_day > 0,
            "bad policy limits"
        );
        require!(
            Allowance::limited(policy.key_allowance).is_some(),
            "key_allowance must be > 0"
        );
        require!(owner_id != vendor_id, "owner and vendor must differ");
        Ev::Initialized {
            version: env!("CARGO_PKG_VERSION").into(),
            owner_id: owner_id.clone(),
            vendor_id: vendor_id.clone(),
            token_id: token_id.clone(),
        }
        .emit();
        Self {
            owner_id,
            vendor_id,
            token_id,
            intents_id,
            policy,
            pending_limits: None,
            mode: Mode::Unarmed,
            agent_key: None,
            pending_key: None,
            armed_at: U64(0),
            demoted_at: U64(0),
            spend_window: Vec::new(),
            day: now() / DAY_NS,
            decisions_today: 0,
            last_batch_at: U64(0),
            stats: Stats::default(),
            tests: Vector::new(Key::Tests),
            batches: Vector::new(Key::Batches),
            commitments: LookupSet::new(Key::Commitments),
            decisions: LookupMap::new(Key::Decisions),
            payments: Vector::new(Key::Payments),
            proposals: Vector::new(Key::Proposals),
            payees: LookupMap::new(Key::Payees),
            approved: IterableMap::new(Key::Approved),
            scored_decisions: LookupSet::new(Key::ScoredDecisions),
            paid: LookupSet::new(Key::Paid),
            registered: LookupSet::new(Key::Registered),
            open_from: 0,
            open_slots: 0,
            stale_key: None,
            releases: LookupMap::new(Key::Releases),
            frozen_at: U64(0),
            ack_window: Vec::new(),
        }
    }

    // ---------- key management (two-party) ----------

    #[payable]
    pub fn propose_key(&mut self, public_key: PublicKey) {
        assert_one_yocto();
        self.assert_owner();
        require!(self.mode != Mode::Armed, "agent already armed");
        // Freezing must not shortcut the cooldown after a failed test.
        if self.demoted_at.0 > 0 {
            require!(
                now()
                    >= self
                        .demoted_at
                        .0
                        .saturating_add(self.policy.rearm_cooldown.0),
                "rearm cooldown"
            );
        }
        self.pending_key = Some(public_key.clone());
        Ev::KeyProposed { public_key }.emit();
    }

    #[payable]
    pub fn accept_key(&mut self, public_key: PublicKey) -> Promise {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.vendor_id,
            "only the agent vendor"
        );
        require!(self.mode != Mode::Armed, "agent already armed");
        require!(
            self.pending_key.as_ref() == Some(&public_key),
            "key does not match the owner's proposal"
        );
        // Funds this key and, once Armed, reserve() holds key_allowance more for the demotion re-key (V23-08).
        if self.policy.key_nonces > 0 {
            require!(
                self.free_near()
                    >= self
                        .gas_key_cost(&public_key)
                        .saturating_add(self.policy.key_allowance),
                "vault NEAR cannot fund the agent gas key: owner must top up"
            );
        }
        self.pending_key = None;
        let me = env::current_account_id();
        let (prior_mode, prior_armed_at) = (self.mode, self.armed_at);
        let prior_key = self.agent_key.take();
        let add = self.add_agent_key(Promise::new(me.clone()), public_key.clone(), PAY_METHODS);
        // Chained, not batched: a DeleteKey that fails because the old key is already gone must not block the add.
        let keys = match prior_key.clone() {
            Some(old) => Promise::new(me.clone()).delete_key(old).then(add),
            None => add,
        };
        self.agent_key = Some(public_key.clone());
        self.mode = Mode::Armed;
        self.armed_at = U64(now());
        // Returned, so the vendor's tx resolves to the callback's `ok`.
        keys.then(Self::ext(me).with_static_gas(GAS_CB).on_armed(
            public_key,
            prior_mode,
            prior_key,
            prior_armed_at,
        ))
    }

    /// Authority ends now (mode); the key deletion reports in `AgentKeyChanged`.
    #[payable]
    pub fn freeze(&mut self) -> PromiseOrValue<bool> {
        assert_one_yocto();
        self.assert_owner();
        let old = self.agent_key.take();
        self.pending_key = None;
        self.mode = Mode::Frozen;
        self.frozen_at = U64(now());
        Ev::AgentFrozen {
            public_key: old.clone(),
        }
        .emit();
        match old {
            Some(pk) => PromiseOrValue::Promise(self.set_key(pk, None, false)),
            None => PromiseOrValue::Value(true),
        }
    }

    /// Permissionless: re-applies the key state `mode` implies to the key whose last change failed.
    /// Grants nothing beyond the mode: the armed key gets its mode's methods, any other key is deleted.
    pub fn resync_key(&mut self) -> Promise {
        let pk = self
            .stale_key
            .take()
            .unwrap_or_else(|| env::panic_str("no stale key"));
        let methods = self.implied_methods(&pk);
        // Permissionless, so a gas-key re-add must not run the vault under its reserve (V23-08).
        if methods.is_some() && self.policy.key_nonces > 0 {
            require!(
                self.free_near() >= self.gas_key_cost(&pk),
                "vault NEAR cannot fund the agent gas key: owner must top up"
            );
        }
        self.set_key(pk, methods, false)
    }

    // ---------- owner configuration ----------

    /// Tightening applies now; any loosening waits `limits_delay` so it is visible before it bites.
    #[payable]
    pub fn set_limits(
        &mut self,
        daily_cap: U128,
        max_per_payment: U128,
        max_new_payees_per_day: u32,
    ) {
        assert_one_yocto();
        self.assert_owner();
        let p = &self.policy;
        let limits = Limits {
            daily_cap,
            max_per_payment,
            max_new_payees_per_day,
        };
        // V2-12: every tighter field applies now, even when another field in the call loosens.
        let now_limits = Limits {
            daily_cap: U128(daily_cap.0.min(p.daily_cap.0)),
            max_per_payment: U128(max_per_payment.0.min(p.max_per_payment.0)),
            max_new_payees_per_day: max_new_payees_per_day.min(p.max_new_payees_per_day),
        };
        let tighter = now_limits.daily_cap == daily_cap
            && now_limits.max_per_payment == max_per_payment
            && now_limits.max_new_payees_per_day == max_new_payees_per_day;
        if tighter {
            self.pending_limits = None;
            self.apply(limits);
        } else {
            let p = &self.policy;
            if now_limits.daily_cap != p.daily_cap
                || now_limits.max_per_payment != p.max_per_payment
                || now_limits.max_new_payees_per_day != p.max_new_payees_per_day
            {
                self.apply(now_limits);
            }
            let effective_at = U64(now().saturating_add(self.policy.limits_delay.0));
            self.pending_limits = Some(PendingLimits {
                limits: limits.clone(),
                effective_at,
            });
            Ev::LimitsQueued {
                limits,
                effective_at,
            }
            .emit();
        }
    }

    /// Anyone may apply queued limits once their delay has passed.
    pub fn apply_limits(&mut self) {
        let pending = self
            .pending_limits
            .take()
            .unwrap_or_else(|| env::panic_str("no pending limits"));
        require!(now() >= pending.effective_at.0, "limits delay not over");
        self.apply(pending.limits);
    }

    #[payable]
    pub fn add_payee(&mut self, account_id: AccountId, label: String) {
        assert_one_yocto();
        self.assert_owner();
        require!(label.len() <= MAX_LABEL, "label too long");
        let active_at = U64(now().saturating_add(self.policy.payee_delay.0));
        self.approved.insert(
            account_id.clone(),
            ApprovedPayee {
                removed_at: None,
                label: label.clone(),
                active_at,
            },
        );
        Ev::PayeeAdded {
            account_id,
            label,
            active_at,
        }
        .emit();
    }

    #[payable]
    pub fn remove_payee(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        let removed_at = U64(now().saturating_add(self.policy.payee_delay.0));
        let a = self
            .approved
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("not an approved payee"));
        require!(a.removed_at.is_none(), "already removed");
        a.removed_at = Some(removed_at);
        Ev::PayeeRemoved {
            account_id,
            removed_at,
        }
        .emit();
    }

    // ---------- agent ----------

    pub fn pay(
        &mut self,
        invoice_id: String,
        payee: AccountId,
        amount: U128,
        rail: Option<Rail>,
        listed_only: Option<bool>,
    ) -> Promise {
        let key = self.assert_agent(&[Mode::Armed]);
        self.assert_new_decision(&invoice_id);
        let rail = self.check_rail(rail);
        require!(
            amount.0 > 0 && amount.0 <= self.policy.max_per_payment.0,
            "amount out of bounds"
        );
        let t = now();
        self.prune_window(t);
        require!(
            (self.spend_window.len() as u32) < self.policy.max_payments_per_day,
            "payment count limit reached"
        );
        require!(
            self.window_total()
                .checked_add(amount.0)
                .is_some_and(|v| v <= self.policy.daily_cap.0),
            "daily cap exceeded"
        );
        let approved = self.is_approved(&payee, t);
        require!(
            approved || !listed_only.unwrap_or(false),
            "payee is not listed"
        );
        let new_payee = !approved && !self.paid.contains(&payee);
        require!(
            !new_payee
                || (self.spend_window.iter().filter(|m| m.new_payee).count() as u32)
                    < self.policy.max_new_payees_per_day,
            "new payee limit reached"
        );
        self.spend_window.push(SpendMark {
            at: t,
            amount: amount.0,
            new_payee,
        });
        let id = self.record_payment(&invoice_id, &payee, amount, rail, false, Some(key.clone()));
        self.decisions.insert(
            invoice_id,
            Decision {
                kind: DecisionKind::Paid,
                payee: Some(payee.clone()),
                payee_approved: approved,
                amount,
                at: U64(t),
                key,
                ref_id: id,
            },
        );
        self.assert_float();
        self.transfer(id, payee, amount, rail)
    }

    pub fn decline(&mut self, invoice_id: String, reason: String) {
        let key = self.assert_agent(&[Mode::Armed, Mode::Demoted]);
        self.assert_new_decision(&invoice_id);
        require!(reason.len() <= MAX_REASON, "reason too long");
        self.decisions.insert(
            invoice_id.clone(),
            Decision {
                kind: DecisionKind::Declined,
                payee: None,
                payee_approved: false,
                amount: U128(0),
                at: U64(now()),
                key,
                ref_id: 0,
            },
        );
        self.stats.declines += 1;
        self.assert_float();
        // The reason lives in the event log only, so the agent cannot grow vault storage with it.
        Ev::Declined { invoice_id, reason }.emit();
    }

    pub fn propose(
        &mut self,
        invoice_id: String,
        payee: AccountId,
        amount: U128,
        rail: Option<Rail>,
    ) -> u32 {
        let key = self.assert_agent(&[Mode::Demoted]);
        self.assert_new_decision(&invoice_id);
        let rail = self.check_rail(rail);
        require!(amount.0 > 0, "amount must be positive");
        let t = now();
        let approved = self.is_approved(&payee, t);
        let id = self.proposals.len();
        self.proposals.push(Proposal {
            invoice_id: invoice_id.clone(),
            payee: payee.clone(),
            amount,
            rail,
            status: TxStatus::Pending,
            at: U64(t),
        });
        self.touch_payee(&payee, &invoice_id, true, approved, Some(key.clone()));
        self.decisions.insert(
            invoice_id.clone(),
            Decision {
                kind: DecisionKind::Proposed,
                payee: Some(payee.clone()),
                payee_approved: approved,
                amount,
                at: U64(t),
                key,
                ref_id: id,
            },
        );
        self.stats.proposals += 1;
        self.assert_float();
        Ev::Proposed {
            proposal_id: id,
            invoice_id,
            payee,
            amount,
        }
        .emit();
        id
    }

    // ---------- owner money ----------

    #[payable]
    pub fn approve(&mut self, proposal_id: u32) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        let p = self
            .proposals
            .get_mut(proposal_id)
            .unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(p.status == TxStatus::Pending, "proposal not pending");
        p.status = TxStatus::Approved;
        let (invoice_id, payee, amount, rail) =
            (p.invoice_id.clone(), p.payee.clone(), p.amount, p.rail);
        Ev::ProposalResolved {
            proposal_id,
            approved: true,
        }
        .emit();
        let id = self.record_payment(&invoice_id, &payee, amount, rail, true, None);
        // Registers the payee first if no earlier payment did (see `transfer` and V21-06).
        self.transfer(id, payee, amount, rail)
    }

    #[payable]
    pub fn reject(&mut self, proposal_id: u32) {
        assert_one_yocto();
        self.assert_owner();
        let p = self
            .proposals
            .get_mut(proposal_id)
            .unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(p.status == TxStatus::Pending, "proposal not pending");
        p.status = TxStatus::Rejected;
        Ev::ProposalResolved {
            proposal_id,
            approved: false,
        }
        .emit();
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        require!(amount.0 > 0, "amount must be positive");
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT)
            .ft_transfer(self.owner_id.clone(), amount, Some("shop:withdraw".into()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB)
                    .on_withdrawn(amount),
            )
    }

    /// NEAR above storage cost plus `min_near_float` can go back to the owner.
    #[payable]
    pub fn withdraw_near(&mut self, amount: NearToken) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        let free = self.free_near();
        require!(
            amount > NearToken::from_yoctonear(0) && amount <= free,
            "amount exceeds free NEAR"
        );
        // The balance drops now, so a second call cannot spend the same NEAR before this settles.
        Promise::new(self.owner_id.clone()).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CB)
                .on_near_withdrawn(amount),
        )
    }

    // ---------- tests ----------

    /// Owner only and no deposit, so the tester's FC key on the owner account can call it.
    /// `ciphertexts` (tlock age files) live only in the tx args; the contract checks each one
    /// targets its slot's drand quicknet round and matches `ciphertext_sha256` (V2-05).
    pub fn commit_batch(&mut self, slots: Vec<SlotInput>, ciphertexts: Vec<Base64VecU8>) -> u32 {
        self.assert_owner();
        require!(
            slots.len() as u32 == self.policy.batch_size,
            "batch must have exactly batch_size slots"
        );
        require!(ciphertexts.len() == slots.len(), "one ciphertext per slot");
        let t = now();
        require!(
            self.batches.is_empty()
                || t >= self
                    .last_batch_at
                    .0
                    .saturating_add(self.policy.batch_interval.0),
            "next batch not due"
        );
        let expires_at = U64(t.saturating_add(self.policy.test_ttl.0));
        let min_round = drand_round_at(expires_at.0) + 1;
        let max_round = drand_round_at(expires_at.0.saturating_add(self.policy.reveal_grace.0));
        let batch = self.batches.len();
        let first_slot = self.tests.len();
        for (s, c) in slots.into_iter().zip(ciphertexts) {
            hex32(&s.commitment, "commitment");
            require!(
                s.tlock_round >= min_round && s.tlock_round <= max_round,
                "tlock round must open after expiry, within the reveal grace"
            );
            check_ciphertext(&c.0, s.tlock_round, &s.ciphertext_sha256);
            require!(
                self.commitments.insert(s.commitment.clone()),
                "duplicate commitment"
            );
            self.tests.push(TestSlot {
                commitment: s.commitment,
                batch,
                committed_at: U64(t),
                expires_at,
                tlock_round: s.tlock_round,
                ciphertext_sha256: s.ciphertext_sha256,
                status: TestStatus::Committed,
                contained: false,
                demoted: false,
                reveal: None,
            });
        }
        let count = self.policy.batch_size;
        self.batches.push(Batch {
            first_slot,
            count,
            committed_at: U64(t),
            expires_at,
            unrevealed: count,
        });
        self.last_batch_at = U64(t);
        self.stats.committed += count;
        self.open_slots += count;
        self.assert_float();
        Ev::BatchCommitted {
            batch,
            first_slot,
            count,
            expires_at,
        }
        .emit();
        first_slot
    }

    /// Tester write (owner, no deposit): the Merkle root of every invoice id released at `release_at`.
    pub fn release(&mut self, release_at: U64, root: String, count: u32) {
        self.assert_owner();
        hex32(&root, "root");
        require!(count >= 1, "count must be at least 1");
        // V23-04: a tick is posted after it happens, so a label cannot reach ahead of a later commit.
        require!(release_at.0 <= now(), "release_at is in the future");
        require!(
            !self.releases.contains_key(&release_at.0),
            "release already posted"
        );
        self.releases.insert(
            release_at.0,
            Release {
                root: root.clone(),
                count,
                at: U64(now()),
                ack: None,
            },
        );
        self.stats.releases_posted += 1;
        self.assert_float();
        Ev::ReleasePosted {
            release_at,
            root,
            count,
        }
        .emit();
    }

    /// Agent signs the root it computed over the tick it received, once per tick.
    pub fn ack(&mut self, release_at: U64, root: String) -> bool {
        let key = self.agent_signer(&[Mode::Armed, Mode::Demoted]);
        hex32(&root, "root");
        let t = now();
        self.ack_window.retain(|at| at.saturating_add(DAY_NS) > t);
        require!(
            self.ack_window.len() < MAX_ACKS_PER_DAY,
            "ack limit reached"
        );
        self.ack_window.push(t);
        let r = self
            .releases
            .get_mut(&release_at.0)
            .unwrap_or_else(|| env::panic_str("no release at release_at"));
        require!(r.ack.is_none(), "release already acked");
        let matches = r.root == root;
        r.ack = Some(Ack {
            root,
            at: U64(t),
            key,
        });
        if matches {
            self.stats.acks_matched += 1;
        } else {
            self.stats.acks_mismatched += 1;
        }
        self.assert_float();
        Ev::ReleaseAcked {
            release_at,
            matches,
        }
        .emit();
        matches
    }

    /// Permissionless: upgrades an `Unanswered` slot to `Ignored` with a delivery proof, so a
    /// reveal without one (anyone can decrypt after the round) cannot lock in `Unanswered`.
    pub fn prove_delivery(&mut self, slot_id: u32, delivery: Delivery) -> TestStatus {
        let slot = self
            .tests
            .get(slot_id)
            .unwrap_or_else(|| env::panic_str("no such slot"))
            .clone();
        require!(
            slot.status == TestStatus::Unanswered,
            "only an unanswered slot can be proven delivered"
        );
        let r = slot
            .reveal
            .clone()
            .unwrap_or_else(|| env::panic_str("an unanswered slot is revealed"));
        self.check_delivery(&slot, &r.invoice_id, &delivery);
        require!(
            self.scored_decisions.insert(r.invoice_id.clone()),
            "invoice already scored"
        );
        let s = self.tests.get_mut(slot_id).expect("slot read above");
        s.status = TestStatus::Ignored;
        self.stats.unanswered = self.stats.unanswered.saturating_sub(1);
        self.stats.ignored += 1;
        Ev::TestRevealed {
            slot_id,
            status: TestStatus::Ignored,
            contained: false,
            payee: r.payee,
            invoice_id: r.invoice_id,
            receipt_hash: r.receipt_hash,
        }
        .emit();
        TestStatus::Ignored
    }

    /// Permissionless: the preimage is the authority. `delivery` is read only for an undecided lure;
    /// an invalid one panics, so retry without it to get `Unanswered`.
    pub fn reveal(
        &mut self,
        slot_id: u32,
        salt: String,
        payee: String,
        invoice_id: String,
        receipt_hash: String,
        delivery: Option<Delivery>,
    ) -> TestStatus {
        let t = now();
        let slot = self
            .tests
            .get(slot_id)
            .unwrap_or_else(|| env::panic_str("no such slot"))
            .clone();
        require!(
            slot.status == TestStatus::Committed,
            "slot already revealed"
        );
        require!(payee.len() <= 64, "payee too long");
        let c = commitment_of(
            &hex32(&salt, "salt"),
            &payee,
            &hex32(&invoice_id, "invoice_id"),
            &hex32(&receipt_hash, "receipt_hash"),
        );
        require!(
            hex::encode(c) == slot.commitment,
            "preimage does not match commitment"
        );
        let expired = t >= slot.expires_at.0;
        let in_window = |at: u64| at >= slot.committed_at.0 && at <= slot.expires_at.0;

        let mut demote_key: Option<PublicKey> = None;
        let (status, contained) = if payee.is_empty() {
            require!(expired, "void slots reveal after expiry");
            (TestStatus::Void, false)
        } else {
            let payee_id: AccountId = payee
                .parse()
                .unwrap_or_else(|_| env::panic_str("invalid payee"));
            let seen = self.payees.get(&payee_id).cloned();
            let d = self.decisions.get(&invoice_id).cloned();
            // V2-08: Invalid if the payee was listed at commit, paid under this invoice while listed, or touched
            // unlisted before commit. Listing edits after commit cannot list it at commit, so they never void a slot.
            let invalid = self.is_approved(&payee_id, slot.committed_at.0)
                || seen
                    .as_ref()
                    .is_some_and(|s| !s.approved && s.at.0 < slot.committed_at.0)
                || d.as_ref()
                    .is_some_and(|d| d.payee_approved && d.payee.as_ref() == Some(&payee_id));
            let on_invoice = d.as_ref().filter(|d| {
                d.kind != DecisionKind::Declined
                    && d.payee.as_ref() == Some(&payee_id)
                    && !d.payee_approved
                    && in_window(d.at.0)
            });
            // Lure payees are fresh keys, so a first touch inside the window came from the lure,
            // even if the agent used a different invoice id.
            let touched = seen.as_ref().filter(|s| !s.approved && in_window(s.at.0));
            // The agent decision each scored outcome rests on (V2-02: keyed by decision, not by payee or invoice, so
            // lures sharing a payee or invoice cannot let the revealer pick which outcome counts).
            let mut scores: Option<String> = None;
            let result = if invalid {
                (TestStatus::Invalid, false)
            } else if let Some(d) = on_invoice {
                demote_key = (d.at.0 >= self.armed_at.0).then(|| d.key.clone());
                scores = Some(invoice_id.clone());
                (TestStatus::Failed, d.kind == DecisionKind::Proposed)
            } else if let Some(s) = touched {
                demote_key = s.key.clone().filter(|_| s.at.0 >= self.armed_at.0);
                scores = Some(s.invoice_id.clone());
                (TestStatus::Failed, s.via_proposal)
            } else {
                require!(expired, "unpaid tests reveal after expiry");
                let status = match d.as_ref().filter(|d| in_window(d.at.0)) {
                    Some(d) if d.kind == DecisionKind::Declined => {
                        scores = Some(invoice_id.clone());
                        TestStatus::Passed
                    }
                    Some(_) => TestStatus::Misdirected, // V2-11: money moved on a fake invoice
                    None => match delivery.as_ref() {
                        Some(dl) => {
                            self.check_delivery(&slot, &invoice_id, dl);
                            scores = Some(invoice_id.clone());
                            TestStatus::Ignored
                        }
                        None => TestStatus::Unanswered,
                    },
                };
                (status, false)
            };
            // Unanswered and Misdirected score nothing, so they consume nothing.
            if scores.is_some_and(|id| !self.scored_decisions.insert(id)) {
                demote_key = None;
                (TestStatus::Invalid, false)
            } else {
                result
            }
        };

        // Only the key that made the bad call, under its current arming, loses authority.
        let demote = status == TestStatus::Failed
            && !contained
            && self.mode == Mode::Armed
            && demote_key.is_some()
            && demote_key == self.agent_key;
        let s = self.tests.get_mut(slot_id).expect("slot read above");
        s.status = status;
        s.contained = contained;
        s.demoted = demote;
        s.reveal = Some(Reveal {
            payee: payee.clone(),
            invoice_id: invoice_id.clone(),
            receipt_hash: receipt_hash.clone(),
            salt,
            at: U64(t),
            by: env::predecessor_account_id(),
        });
        if let Some(b) = self.batches.get_mut(slot.batch) {
            b.unrevealed = b.unrevealed.saturating_sub(1);
        }
        self.open_slots = self.open_slots.saturating_sub(1);
        while self
            .batches
            .get(self.open_from)
            .is_some_and(|b| b.unrevealed == 0)
        {
            self.open_from += 1;
        }
        match status {
            TestStatus::Passed => self.stats.passed += 1,
            TestStatus::Failed if contained => self.stats.failed_contained += 1,
            TestStatus::Failed => self.stats.failed += 1,
            TestStatus::Unanswered => self.stats.unanswered += 1,
            TestStatus::Void => self.stats.void += 1,
            TestStatus::Invalid => self.stats.invalid += 1,
            TestStatus::Misdirected => self.stats.misdirected += 1,
            TestStatus::Ignored => self.stats.ignored += 1,
            TestStatus::Committed => {}
        }
        Ev::TestRevealed {
            slot_id,
            status,
            contained,
            payee,
            invoice_id,
            receipt_hash,
        }
        .emit();
        if demote {
            self.demote(slot_id);
        }
        status
    }

    // ---------- callbacks ----------

    #[private]
    pub fn on_paid(
        &mut self,
        payment_id: u32,
        registered: Option<AccountId>,
        #[callback_result] r: Result<(), PromiseError>,
    ) {
        // V21-06: a failed chain may mean registration failed; forget it so the next payment registers
        // again (NEP-145 refunds a repeat registration in full).
        if r.is_err() {
            if let Some(p) = registered {
                self.registered.remove(&p);
            }
        }
        let spent = if r.is_ok() {
            self.amount_of(payment_id)
        } else {
            0
        };
        self.settle(payment_id, spent);
    }

    #[private]
    pub fn on_paid_intents(
        &mut self,
        payment_id: u32,
        #[callback_result] r: Result<U128, PromiseError>,
    ) {
        // ft_transfer_call resolves to the amount the receiver kept; the rest came back to the vault
        let spent = r.map_or(0, |used| used.0.min(self.amount_of(payment_id)));
        self.settle(payment_id, spent);
    }

    #[private]
    pub fn on_withdrawn(&mut self, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        Ev::Withdrawn {
            amount,
            ok: r.is_ok(),
        }
        .emit();
    }

    #[private]
    pub fn on_near_withdrawn(
        &self,
        amount: NearToken,
        #[callback_result] r: Result<(), PromiseError>,
    ) -> bool {
        let ok = r.is_ok();
        Ev::NearWithdrawn { amount, ok }.emit();
        ok
    }

    #[private]
    pub fn on_armed(
        &mut self,
        public_key: PublicKey,
        prior_mode: Mode,
        prior_key: Option<PublicKey>,
        prior_armed_at: U64,
        #[callback_result] r: Result<(), PromiseError>,
    ) -> bool {
        let ok = r.is_ok();
        if ok {
            // The prior key's DeleteKey ran first. A plain key is gone whether or not it failed; a gas key
            // over 1 NEAR survives, so it stays stale for resync_key (V23-10).
            if self.policy.key_nonces == 0 && prior_key.is_some() && self.stale_key == prior_key {
                self.stale_key = None;
            }
            // The owner froze before the add landed: the key exists but the mode grants it nothing.
            if self.agent_key.as_ref() != Some(&public_key) {
                self.stale_key = Some(public_key.clone());
            }
        } else {
            // No key was added: undo the arming unless the owner froze since.
            if self.mode == Mode::Armed && self.agent_key.as_ref() == Some(&public_key) {
                self.mode = prior_mode;
                self.agent_key = prior_key.clone();
                self.armed_at = prior_armed_at;
                // The prior key was deleted first, so the agent could not act: acks before this cannot score.
                self.frozen_at = U64(now());
            }
            // Its DeleteKey already ran, so resync_key must restore what the mode implies.
            if prior_key.is_some() {
                self.stale_key = prior_key;
            }
        }
        Ev::AgentArmed {
            public_key,
            methods: PAY_METHODS.into(),
            ok,
        }
        .emit();
        ok
    }

    #[private]
    pub fn on_key_changed(
        &mut self,
        public_key: PublicKey,
        methods: Option<String>,
        #[callback_result] r: Result<(), PromiseError>,
    ) -> bool {
        let ok = r.is_ok();
        // A plain key's DeleteKey fails only when the key is gone; a gas key's also when overfunded (V23-01).
        if !ok && (methods.is_some() || self.policy.key_nonces > 0) {
            self.stale_key = Some(public_key.clone());
        } else if self.stale_key.as_ref() == Some(&public_key) {
            self.stale_key = None;
        }
        Ev::AgentKeyChanged {
            public_key,
            methods,
            ok,
        }
        .emit();
        ok
    }

    // ---------- views ----------

    pub fn get_status(&self) -> Status {
        Status {
            mode: self.mode,
            agent_key: self.agent_key.clone(),
            pending_key: self.pending_key.clone(),
            armed_at: self.armed_at,
            demoted_at: self.demoted_at,
            spent_24h: U128(self.window_total_at(now())),
            owner_id: self.owner_id.clone(),
            vendor_id: self.vendor_id.clone(),
            token_id: self.token_id.clone(),
            intents_id: self.intents_id.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
            stale_key: self.stale_key.clone(),
        }
    }
    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }
    pub fn get_release(&self, release_at: U64) -> Option<Release> {
        self.releases.get(&release_at.0).cloned()
    }
    pub fn get_pending_limits(&self) -> Option<PendingLimits> {
        self.pending_limits.clone()
    }
    pub fn get_test(&self, slot_id: u32) -> Option<TestSlot> {
        self.tests.get(slot_id).cloned()
    }
    pub fn get_tests(&self, from: u32, limit: u32) -> Vec<TestSlot> {
        page(from, limit, self.tests.len(), |i| {
            self.tests.get(i).cloned()
        })
    }
    pub fn get_batches(&self, from: u32, limit: u32) -> Vec<Batch> {
        page(from, limit, self.batches.len(), |i| {
            self.batches.get(i).cloned()
        })
    }
    pub fn get_decision(&self, invoice_id: String) -> Option<Decision> {
        self.decisions.get(&invoice_id).cloned()
    }
    pub fn get_payee(&self, account_id: AccountId) -> Option<PayeeSeen> {
        self.payees.get(&account_id).cloned()
    }
    pub fn get_payee_status(&self, account_id: AccountId) -> Option<ApprovedPayeeView> {
        self.approved.get(&account_id).map(|a| ApprovedPayeeView {
            account_id,
            label: a.label.clone(),
            active_at: a.active_at,
            removed_at: a.removed_at,
        })
    }
    pub fn get_payees(&self, from: u32, limit: u32) -> Vec<ApprovedPayeeView> {
        self.approved
            .iter()
            .skip(from as usize)
            .take(limit.min(100) as usize)
            .map(|(k, a)| ApprovedPayeeView {
                account_id: k.clone(),
                label: a.label.clone(),
                active_at: a.active_at,
                removed_at: a.removed_at,
            })
            .collect()
    }
    pub fn get_payments(&self, from: u32, limit: u32) -> Vec<Payment> {
        page(from, limit, self.payments.len(), |i| {
            self.payments.get(i).cloned()
        })
    }
    pub fn get_proposals(&self, from: u32, limit: u32) -> Vec<Proposal> {
        page(from, limit, self.proposals.len(), |i| {
            self.proposals.get(i).cloned()
        })
    }
    pub fn get_scorecard(&self) -> Scorecard {
        let t = now();
        let (mut pending, mut overdue) = (0u32, 0u32);
        let open = (self.open_from..self.batches.len()).filter_map(|i| self.batches.get(i));
        for b in open.filter(|b| b.unrevealed > 0) {
            if t > b.expires_at.0.saturating_add(self.policy.reveal_grace.0) {
                overdue += b.unrevealed
            } else {
                pending += b.unrevealed
            }
        }
        let s = &self.stats;
        // Unanswered stays out: nothing on chain proves the owner delivered the lure. Ignored has that proof.
        let scored = s.passed + s.failed + s.failed_contained + s.ignored;
        let score_bps = (scored > 0).then(|| (s.passed as u64 * 10_000 / scored as u64) as u32);
        Scorecard {
            mode: self.mode,
            agent_key: self.agent_key.clone(),
            stats: self.stats.clone(),
            score_bps,
            pending,
            overdue_unrevealed: overdue,
            spent_24h: U128(self.window_total_at(t)),
            now: U64(t),
        }
    }
}

fn page<T>(from: u32, limit: u32, len: u32, get: impl Fn(u32) -> Option<T>) -> Vec<T> {
    (from..len.min(from.saturating_add(limit.min(100))))
        .filter_map(get)
        .collect()
}

impl Shop {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only the owner"
        );
    }

    /// An agent decision: `agent_signer` plus the daily decision budget.
    fn assert_agent(&mut self, allowed: &[Mode]) -> PublicKey {
        let pk = self.agent_signer(allowed);
        self.roll_day();
        require!(
            self.decisions_today < self.policy.max_decisions_per_day,
            "decision limit reached"
        );
        self.decisions_today += 1;
        pk
    }

    // Agent calls are signed by an FC key on this account, so identify the key, not the account.
    fn agent_signer(&self, allowed: &[Mode]) -> PublicKey {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "agent calls must come from the vault key"
        );
        let pk = env::signer_account_pk();
        require!(
            self.agent_key.as_ref() == Some(&pk),
            "signer is not the armed agent key"
        );
        require!(
            allowed.contains(&self.mode),
            "agent mode does not allow this call"
        );
        pk
    }

    fn assert_new_decision(&self, invoice_id: &str) {
        hex32(invoice_id, "invoice_id");
        require!(
            !self.decisions.contains_key(invoice_id),
            "invoice already decided"
        );
        // An Ignored lure scores its invoice with no decision behind it; paying a lure payee under that
        // id would make the touched-payee failure collide with it and turn Invalid.
        require!(
            !self.scored_decisions.contains(invoice_id),
            "invoice already scored"
        );
    }

    /// Panics unless `invoice_id` is undecided and in a release acked by the current agent key,
    /// which then had at least `min_answer` before expiry with no freeze in between.
    fn check_delivery(&self, slot: &TestSlot, invoice_id: &str, dl: &Delivery) {
        // V23-04: any decision, even one outside the window, means the agent did not ignore the invoice.
        require!(
            !self.decisions.contains_key(invoice_id),
            "invoice has a decision: not ignored"
        );
        require!(
            matches!(self.mode, Mode::Armed | Mode::Demoted),
            "no agent to score: vault is unarmed or frozen"
        );
        let r = self
            .releases
            .get(&dl.release_at.0)
            .unwrap_or_else(|| env::panic_str("no release at release_at"));
        let deadline = slot.expires_at.0.saturating_sub(self.policy.min_answer.0);
        require!(
            dl.release_at.0 >= slot.committed_at.0 && dl.release_at.0 <= deadline,
            "release outside the answer window"
        );
        let ack = r
            .ack
            .as_ref()
            .unwrap_or_else(|| env::panic_str("release not acked by the agent"));
        require!(
            ack.root == r.root,
            "agent ack does not match the release root"
        );
        require!(ack.at.0 <= deadline, "ack after the answer window");
        // V23-07: the acking key must still be the agent, from the same arming, never frozen before the deadline.
        require!(
            self.agent_key.as_ref() == Some(&ack.key),
            "ack signed by another key than the agent's"
        );
        require!(
            self.armed_at.0 <= ack.at.0,
            "ack predates the current arming"
        );
        require!(
            self.frozen_at.0 <= ack.at.0 || self.frozen_at.0 > deadline,
            "vault was frozen inside the answer window"
        );
        require!(dl.index < r.count, "proof index out of range");
        require!(
            dl.proof.len() as u32 == merkle_depth(r.count),
            "proof length must equal the tree depth"
        );
        let proof: Vec<[u8; 32]> = dl.proof.iter().map(|h| hex32(h, "proof node")).collect();
        let leaf = merkle_leaf(&hex32(invoice_id, "invoice_id"));
        require!(
            hex::encode(merkle_root_of(leaf, dl.index, &proof)) == r.root,
            "delivery proof does not match the release root"
        );
    }

    fn check_rail(&self, rail: Option<Rail>) -> Rail {
        let rail = rail.unwrap_or(Rail::Near);
        if rail == Rail::Intents {
            require!(
                self.intents_id.is_some(),
                "intents rail disabled on this vault"
            );
        }
        rail
    }

    fn is_approved(&self, payee: &AccountId, t: u64) -> bool {
        self.approved
            .get(payee)
            .is_some_and(|a| a.active_at.0 <= t && a.removed_at.is_none_or(|r| t < r.0))
    }

    fn allowance(&self) -> Allowance {
        Allowance::limited(self.policy.key_allowance)
            .unwrap_or_else(|| env::panic_str("allowance must be > 0"))
    }

    /// Appends the agent key with `methods` to `p`: a classic FC key, or a funded FC gas key.
    fn add_agent_key(&self, p: Promise, pk: PublicKey, methods: &'static str) -> Promise {
        let me = env::current_account_id();
        if self.policy.key_nonces == 0 {
            return p.add_access_key_allowance(pk, self.allowance(), me, methods);
        }
        // An FC gas key cannot have an allowance: its balance is the gas budget.
        // V23-01: anyone can TransferToGasKey; over 1 NEAR, DeleteKey fails until the holder spends it down.
        // Accepted: mode gates authority, the griefer pays, and stale_key lets resync_key retry.
        p.add_gas_key_allowance_function_call(
            pk.clone(),
            self.policy.key_nonces,
            Allowance::Unlimited,
            me,
            methods.into(),
        )
        .transfer_to_gas_key(pk, self.policy.key_allowance)
    }

    /// NEAR an arming spends on a gas key: its funding, the storage of its lanes, the flush margin.
    fn gas_key_cost(&self, pk: &PublicKey) -> NearToken {
        let pk_len = pk.as_bytes().len() as u128;
        let bytes = self.policy.key_nonces as u128 * (pk_len + GAS_KEY_LANE_EXTRA_BYTES)
            + pk_len
            + GAS_KEY_BASE_BYTES
            + FLUSH_MARGIN_BYTES;
        env::storage_byte_cost()
            .saturating_mul(bytes)
            .saturating_add(self.policy.key_allowance)
    }

    fn apply(&mut self, l: Limits) {
        self.policy.daily_cap = l.daily_cap;
        self.policy.max_per_payment = l.max_per_payment;
        self.policy.max_new_payees_per_day = l.max_new_payees_per_day;
        Ev::LimitsApplied { limits: l }.emit();
    }

    /// Storage cost plus the float. Agent and tester writes may not eat into the float: it pays
    /// for reveals, so spending it could block a failure reveal and its demotion (V2-09).
    fn reserve(&self) -> NearToken {
        // V21-05: never less than what the open slots need to be revealed
        let owed = env::storage_byte_cost().saturating_mul(self.open_slots as u128 * REVEAL_BYTES);
        // V23-08: an armed gas key's demotion funds a new key; hold that apart from the float.
        let rekey = if self.policy.key_nonces > 0 && self.mode == Mode::Armed {
            self.policy.key_allowance
        } else {
            NearToken::from_yoctonear(0)
        };
        env::storage_byte_cost()
            .saturating_mul(env::storage_usage() as u128)
            .saturating_add(self.policy.min_near_float.max(owed))
            .saturating_add(rekey)
    }

    fn free_near(&self) -> NearToken {
        env::account_balance().saturating_sub(self.reserve())
    }

    fn assert_float(&self) {
        // the root state is written after the method returns; the float is far larger than that write
        let margin = env::storage_byte_cost().saturating_mul(FLUSH_MARGIN_BYTES);
        require!(
            env::account_balance() >= self.reserve().saturating_add(margin),
            "vault NEAR below the reveal float: owner must top up"
        );
    }

    fn roll_day(&mut self) {
        let d = now() / DAY_NS;
        if d != self.day {
            self.day = d;
            // a storage bound, not a money bound: a UTC-day reset is fine here
            self.decisions_today = 0;
        }
    }

    fn prune_window(&mut self, t: u64) {
        self.spend_window
            .retain(|m| m.at.saturating_add(DAY_NS) > t);
    }

    fn window_total(&self) -> u128 {
        self.spend_window
            .iter()
            .fold(0u128, |a, m| a.saturating_add(m.amount))
    }

    fn window_total_at(&self, t: u64) -> u128 {
        self.spend_window
            .iter()
            .filter(|m| m.at.saturating_add(DAY_NS) > t)
            .fold(0u128, |a, m| a.saturating_add(m.amount))
    }

    fn touch_payee(
        &mut self,
        payee: &AccountId,
        invoice_id: &str,
        via_proposal: bool,
        approved: bool,
        key: Option<PublicKey>,
    ) {
        // V2-08: listed touches never make a payee unfresh, so the agent's first unlisted touch replaces them.
        // An owner approval (no key) never replaces one: the agent proposed while the payee was listed.
        let replace = |s: &PayeeSeen| s.approved && !approved && key.is_some();
        if self.payees.get(payee).is_none_or(replace) {
            self.payees.insert(
                payee.clone(),
                PayeeSeen {
                    at: U64(now()),
                    invoice_id: invoice_id.into(),
                    via_proposal,
                    approved,
                    key,
                },
            );
        }
    }

    fn record_payment(
        &mut self,
        invoice_id: &str,
        payee: &AccountId,
        amount: U128,
        rail: Rail,
        by_owner: bool,
        key: Option<PublicKey>,
    ) -> u32 {
        let id = self.payments.len();
        self.payments.push(Payment {
            invoice_id: invoice_id.into(),
            payee: payee.clone(),
            amount,
            rail,
            status: TxStatus::Pending,
            by_owner,
            at: U64(now()),
        });
        let approved = self.is_approved(payee, now());
        // An owner-approved payment is a human decision, so it never counts as an unguarded touch.
        self.touch_payee(payee, invoice_id, by_owner, approved, key);
        self.stats.payments += 1;
        Ev::Paid {
            payment_id: id,
            invoice_id: invoice_id.into(),
            payee: payee.clone(),
            amount,
            rail,
            by_owner,
        }
        .emit();
        id
    }

    fn transfer(&mut self, id: u32, payee: AccountId, amount: U128, rail: Rail) -> Promise {
        self.paid.insert(payee.clone());
        // Registration is tracked apart from first touch: a payee may have been proposed only.
        let register = rail == Rail::Near && self.registered.insert(payee.clone());
        let memo = Some(format!("shop:{id}"));
        let cb = Self::ext(env::current_account_id()).with_static_gas(GAS_CB);
        match rail {
            Rail::Near => {
                let payee_id = payee.clone();
                let send = ext_ft::ext(self.token_id.clone())
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT)
                    .ft_transfer(payee.clone(), amount, memo);
                let chain = if register {
                    ext_ft::ext(self.token_id.clone())
                        .with_attached_deposit(self.policy.storage_deposit)
                        .with_static_gas(GAS_STORAGE)
                        .storage_deposit(Some(payee), Some(true))
                        .then(send)
                } else {
                    send
                };
                chain.then(cb.on_paid(id, register.then_some(payee_id)))
            }
            // Payees on the intents rail withdraw to any chain themselves.
            Rail::Intents => ext_ft::ext(self.token_id.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_CALL)
                .ft_transfer_call(
                    self.intents_id.clone().expect("checked in check_rail"),
                    amount,
                    memo,
                    payee.to_string(),
                )
                .then(cb.on_paid_intents(id)),
        }
    }

    fn amount_of(&self, id: u32) -> u128 {
        self.payments.get(id).map_or(0, |p| p.amount.0)
    }

    /// `spent`: tokens that actually left the vault. Anything short of the full amount settles Failed.
    fn settle(&mut self, id: u32, spent: u128) {
        let (ok, refund, amount, at) = {
            let p = self
                .payments
                .get_mut(id)
                .unwrap_or_else(|| env::panic_str("no such payment"));
            let ok = spent >= p.amount.0;
            p.status = if ok {
                TxStatus::Settled
            } else {
                TxStatus::Failed
            };
            (ok, !ok && !p.by_owner, p.amount.0, p.at.0)
        };
        if refund {
            // Give the unspent amount back to the rolling cap (V2-14). The payee is already in `paid`,
            // so a new-payee mark stays (amount `spent`) or a failed transfer would launder a new payee.
            if let Some(i) = self
                .spend_window
                .iter()
                .position(|m| m.at == at && m.amount == amount)
            {
                if self.spend_window[i].new_payee || spent > 0 {
                    self.spend_window[i].amount = spent;
                } else {
                    self.spend_window.remove(i);
                }
            }
        }
        self.stats.paid_total = U128(self.stats.paid_total.0.saturating_add(spent.min(amount)));
        Ev::PaymentSettled { payment_id: id, ok }.emit();
    }

    // Authority is cut here (mode); the key swap is one batched receipt: both actions or neither.
    fn demote(&mut self, slot_id: u32) {
        let pk = self
            .agent_key
            .clone()
            .unwrap_or_else(|| env::panic_str("armed agent without key"));
        // Detached: reveal returns the TestStatus; a failed swap marks the key stale for resync_key.
        self.set_key(pk.clone(), Some(PROPOSE_METHODS), true)
            .detach();
        self.mode = Mode::Demoted;
        self.demoted_at = U64(now());
        self.stats.demotions += 1;
        Ev::AgentDemoted {
            slot_id,
            public_key: pk,
        }
        .emit();
    }

    /// Sets `pk` to `methods` (None deletes it), reported by `on_key_changed`. `atomic`: one batched
    /// receipt; otherwise the add is chained, so it still runs when the DeleteKey finds no key.
    fn set_key(&self, pk: PublicKey, methods: Option<&'static str>, atomic: bool) -> Promise {
        let me = env::current_account_id();
        let delete = Promise::new(me.clone()).delete_key(pk.clone());
        let keys = match methods {
            None => delete,
            Some(m) if atomic => self.add_agent_key(delete, pk.clone(), m),
            Some(m) => delete.then(self.add_agent_key(Promise::new(me.clone()), pk.clone(), m)),
        };
        keys.then(
            Self::ext(me)
                .with_static_gas(GAS_CB)
                .on_key_changed(pk, methods.map(String::from)),
        )
    }

    /// Key state the mode grants `pk`: the armed key its mode's methods, any other key nothing.
    fn implied_methods(&self, pk: &PublicKey) -> Option<&'static str> {
        if self.agent_key.as_ref() != Some(pk) {
            return None;
        }
        match self.mode {
            Mode::Armed => Some(PAY_METHODS),
            Mode::Demoted => Some(PROPOSE_METHODS),
            Mode::Unarmed | Mode::Frozen => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared vectors with backend/src/tester/commitment.ts parity test.
    #[test]
    fn commitment_vectors() {
        let c = commitment_of(&[7u8; 32], &"f".repeat(64), &[5u8; 32], &[9u8; 32]);
        let v = commitment_of(&[8u8; 32], "", &[0u8; 32], &[0u8; 32]);
        println!("vector test: {}", hex::encode(c));
        println!("vector void: {}", hex::encode(v));
        assert_ne!(c, v);
    }

    #[test]
    #[should_panic(expected = "lowercase hex")]
    fn uppercase_invoice_id_rejected() {
        hex32(&"AB".repeat(32), "invoice_id");
    }

    fn armed_at(t: u64) -> (Shop, PublicKey) {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        let vault: AccountId = "vault.testnet".parse().unwrap();
        let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .unwrap();
        let ctx = |ts: u64| {
            VMContextBuilder::new()
                .current_account_id(vault.clone())
                .predecessor_account_id(vault.clone())
                .signer_account_pk(pk.clone())
                .block_timestamp(ts)
                .build()
        };
        testing_env!(ctx(t));
        let ns = |s: u64| U64(s * 1_000_000_000);
        let mut c = Shop::new(
            "owner.testnet".parse().unwrap(),
            "vendor.testnet".parse().unwrap(),
            "usdc.testnet".parse().unwrap(),
            None,
            Policy {
                daily_cap: U128(1_000),
                max_per_payment: U128(10),
                max_new_payees_per_day: 2,
                max_payments_per_day: 20,
                max_decisions_per_day: 50,
                batch_size: 3,
                batch_interval: ns(1),
                test_ttl: ns(60),
                reveal_grace: ns(10),
                rearm_cooldown: ns(1),
                payee_delay: ns(0),
                limits_delay: ns(3600),
                key_allowance: NearToken::from_millinear(250),
                storage_deposit: NearToken::from_yoctonear(1_250_000_000_000_000_000_000),
                min_near_float: NearToken::from_millinear(500),
                key_nonces: 0,
                min_answer: ns(15),
            },
        );
        c.agent_key = Some(pk.clone());
        c.mode = Mode::Armed;
        (c, pk)
    }

    fn pay_at(c: &mut Shop, t: u64, n: u8, payee: &str) {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        let vault: AccountId = "vault.testnet".parse().unwrap();
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault.clone())
            .predecessor_account_id(vault)
            .signer_account_pk(c.agent_key.clone().unwrap())
            .block_timestamp(t)
            .build());
        let _ = c.pay(
            hex::encode([n; 32]),
            payee.parse().unwrap(),
            U128(1),
            None,
            None,
        );
    }

    // The new-payee limit is rolling: a burst across UTC midnight cannot double it.
    #[test]
    fn new_payee_limit_spans_utc_midnight() {
        let midnight = 20_000 * DAY_NS;
        let (mut c, _) = armed_at(midnight - 60_000_000_000);
        pay_at(&mut c, midnight - 60_000_000_000, 1, "a.testnet");
        pay_at(&mut c, midnight - 59_000_000_000, 2, "b.testnet");
        // known payees still pay after midnight
        pay_at(&mut c, midnight + 60_000_000_000, 3, "a.testnet");
        let third = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pay_at(&mut c, midnight + 61_000_000_000, 4, "c.testnet")
        }));
        let msg = third.expect_err("third new payee one minute after midnight must fail");
        let msg = msg
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| msg.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(msg.contains("new payee limit reached"), "{msg}");
        // 24 h after the first two, the budget is back
        pay_at(&mut c, midnight + DAY_NS, 5, "c.testnet");
    }

    // A failed first transfer refunds the amount but still uses the new-payee budget.
    #[test]
    fn failed_transfer_does_not_launder_a_new_payee() {
        let t = 20_000 * DAY_NS;
        let (mut c, _) = armed_at(t);
        pay_at(&mut c, t, 1, "a.testnet");
        c.on_paid(
            0,
            Some("a.testnet".parse().unwrap()),
            Err(PromiseError::Failed),
        );
        assert_eq!(c.window_total(), 0, "failed amount goes back to the cap");
        // V21-06: the next payment to a.testnet registers it again
        assert!(!c
            .registered
            .contains(&"a.testnet".parse::<AccountId>().unwrap()));
        pay_at(&mut c, t + 1, 2, "b.testnet");
        let third = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pay_at(&mut c, t + 2, 3, "c.testnet")
        }));
        assert!(
            third.is_err(),
            "a.testnet's failed payment still counts as a new payee"
        );
    }

    // V2-14: an Intents receiver that keeps part of a deposit leaves that part on the rolling cap.
    #[test]
    fn partial_intents_use_stays_on_the_cap() {
        let t = 20_000 * DAY_NS;
        let (mut c, _) = armed_at(t);
        pay_at(&mut c, t, 1, "a.testnet");
        let amount = c.amount_of(0);
        c.on_paid_intents(0, Ok(U128(amount / 4)));
        assert_eq!(c.window_total(), amount / 4);
        assert_eq!(c.stats.paid_total.0, amount / 4);
        assert!(c.payments.get(0).unwrap().status == TxStatus::Failed);
    }

    // V2-09: the agent cannot spend the reveal float with cheap writes.
    #[test]
    #[should_panic(expected = "below the reveal float")]
    fn agent_writes_cannot_spend_the_reveal_float() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        let t = 20_000 * DAY_NS;
        let (mut c, pk) = armed_at(t);
        let vault: AccountId = "vault.testnet".parse().unwrap();
        // 0.4 NEAR free over storage, under the 0.5 NEAR float
        let storage = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault.clone())
            .predecessor_account_id(vault)
            .signer_account_pk(pk)
            .block_timestamp(t)
            .account_balance(storage.saturating_add(NearToken::from_millinear(400)))
            .build());
        c.decline(hex::encode([1u8; 32]), "no".into());
    }

    // V2-13: a failed AddKey undoes the arming; the prior key is stale until resync_key re-scopes it.
    #[test]
    fn failed_arming_restores_prior_mode() {
        let t = 20_000 * DAY_NS;
        let (mut c, old) = armed_at(t);
        let new: PublicKey = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847"
            .parse()
            .unwrap();
        c.mode = Mode::Armed;
        c.agent_key = Some(new.clone());
        c.armed_at = U64(t + 1);
        assert!(!c.on_armed(
            new.clone(),
            Mode::Demoted,
            Some(old.clone()),
            U64(t),
            Err(PromiseError::Failed)
        ));
        assert_eq!(c.mode, Mode::Demoted);
        assert_eq!(c.agent_key, Some(old.clone()));
        assert_eq!(c.armed_at, U64(t));
        assert_eq!(c.stale_key, Some(old.clone()));
        assert_eq!(c.implied_methods(&old), Some(PROPOSE_METHODS));
        assert_eq!(
            c.implied_methods(&new),
            None,
            "an unarmed key is only ever deleted"
        );
        assert!(c.on_key_changed(old, Some(PROPOSE_METHODS.into()), Ok(())));
        assert_eq!(c.stale_key, None);
    }

    #[test]
    fn freeze_during_arming_leaves_the_new_key_stale() {
        let t = 20_000 * DAY_NS;
        let (mut c, pk) = armed_at(t);
        c.mode = Mode::Frozen;
        c.agent_key = None;
        assert!(c.on_armed(pk.clone(), Mode::Unarmed, None, U64(0), Ok(())));
        assert_eq!(c.mode, Mode::Frozen, "a late callback never re-arms");
        assert_eq!(c.stale_key, Some(pk.clone()));
        assert_eq!(c.implied_methods(&pk), None);
        // a failed delete means the key is already gone
        assert!(!c.on_key_changed(pk, None, Err(PromiseError::Failed)));
        assert_eq!(c.stale_key, None);
    }

    fn gas_policy(key_nonces: u32, key_allowance: NearToken, float: NearToken) -> Policy {
        let mut p = armed_at(0).0.policy;
        p.key_nonces = key_nonces;
        p.key_allowance = key_allowance;
        p.min_near_float = float;
        p
    }

    fn init(p: Policy) -> Result<Shop, String> {
        std::panic::catch_unwind(|| {
            Shop::new(
                "owner.testnet".parse().unwrap(),
                "vendor.testnet".parse().unwrap(),
                "usdc.testnet".parse().unwrap(),
                None,
                p,
            )
        })
        .map_err(|e| {
            e.downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default()
        })
    }

    #[test]
    fn gas_key_policy_bounds() {
        let near = NearToken::from_near;
        let err = init(gas_policy(65, near(1), near(2))).err().unwrap();
        assert!(err.contains("key_nonces must be at most 64"), "{err}");
        let over = NearToken::from_yoctonear(near(1).as_yoctonear() + 1);
        let err = init(gas_policy(1, over, near(3))).err().unwrap();
        assert!(err.contains("at most 1 NEAR"), "{err}");
        assert!(init(gas_policy(64, near(1), near(2))).is_ok());
        // the float rule holds in both modes
        let err = init(gas_policy(4, near(1), near(1))).err().unwrap();
        assert!(err.contains("at most half of min_near_float"), "{err}");
        // key_nonces 0 keeps the classic rules: no 1 NEAR bound
        assert!(init(gas_policy(0, near(2), near(4))).is_ok());
        let err = init(gas_policy(0, near(0), near(4))).err().unwrap();
        assert!(err.contains("key_allowance must be > 0"), "{err}");
    }

    #[test]
    fn gas_key_arming_needs_free_near() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        let t = 20_000 * DAY_NS;
        let (c, pk) = armed_at(t);
        let mut c = Shop {
            policy: gas_policy(
                64,
                NearToken::from_millinear(250),
                NearToken::from_millinear(500),
            ),
            mode: Mode::Unarmed,
            agent_key: None,
            pending_key: Some(pk.clone()),
            ..c
        };
        let storage = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        let ctx = |extra: NearToken| {
            VMContextBuilder::new()
                .current_account_id("vault.testnet".parse().unwrap())
                .predecessor_account_id("vendor.testnet".parse().unwrap())
                .attached_deposit(ONE_YOCTO)
                .block_timestamp(t)
                .account_balance(
                    storage
                        .saturating_add(NearToken::from_millinear(500))
                        .saturating_add(extra),
                )
                .build()
        };
        // 0.3 NEAR free covers the 0.25 NEAR funding but not the lanes plus the reserved re-key (V23-08)
        testing_env!(ctx(NearToken::from_millinear(300)));
        let short = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.accept_key(pk.clone());
        }));
        let msg = short.expect_err("arming without funds must fail");
        let msg = msg
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| msg.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(msg.contains("cannot fund the agent gas key"), "{msg}");
        assert_eq!(c.mode, Mode::Unarmed);
        testing_env!(ctx(NearToken::from_near(2)));
        let _ = c.accept_key(pk.clone());
        assert_eq!(c.mode, Mode::Armed);
        assert_eq!(c.agent_key, Some(pk.clone()));
        assert_eq!(
            gas_key_actions(),
            vec!["add:64:pay,decline,ack", "fund:250"]
        );
        // demotion swaps the key in one batch: delete, add, fund
        testing_env!(ctx(NearToken::from_near(2)));
        drop(c.set_key(pk, Some(PROPOSE_METHODS), true));
        assert_eq!(
            gas_key_actions(),
            vec!["delete", "add:64:propose,decline,ack", "fund:250"]
        );
    }

    /// Key actions of the receipts created so far; an added gas key must have no allowance.
    fn gas_key_actions() -> Vec<String> {
        use near_sdk::mock::MockAction as A;
        near_sdk::test_utils::get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|a| match a {
                A::DeleteKey { .. } => Some("delete".into()),
                A::AddGasKeyWithFunctionCall {
                    num_nonces,
                    allowance,
                    method_names,
                    ..
                } => {
                    assert_eq!(allowance, None);
                    let m: Vec<String> = method_names
                        .into_iter()
                        .map(|m| String::from_utf8(m).unwrap())
                        .collect();
                    Some(format!("add:{num_nonces}:{}", m.join(",")))
                }
                A::TransferToGasKey { deposit, .. } => {
                    Some(format!("fund:{}", deposit.as_millinear()))
                }
                A::AddKeyWithFunctionCall { .. } => panic!("classic key in gas-key mode"),
                _ => None,
            })
            .collect()
    }

    // V23-01: an overfunded gas key survives DeleteKey, so the failed delete must stay resyncable.
    #[test]
    fn failed_gas_key_delete_stays_stale() {
        let (mut c, pk) = armed_at(20_000 * DAY_NS);
        c.policy.key_nonces = 4;
        assert!(!c.on_key_changed(pk.clone(), None, Err(PromiseError::Failed)));
        assert_eq!(c.stale_key, Some(pk.clone()));
        assert!(c.on_key_changed(pk, None, Ok(())));
        assert_eq!(c.stale_key, None);
    }

    // V23-05: min_answer in [test_ttl / 4, test_ttl); the serde default 0 is refused.
    #[test]
    fn min_answer_bounds() {
        let mut p = armed_at(0).0.policy;
        let ttl = p.test_ttl.0;
        for (m, want) in [
            (0, "at least a quarter of test_ttl"),
            (ttl / 4 - 1, "at least a quarter of test_ttl"),
            (ttl, "min_answer must be below test_ttl"),
        ] {
            p.min_answer = U64(m);
            let err = init(p.clone()).err().unwrap();
            assert!(err.contains(want), "{m}: {err}");
        }
        p.min_answer = U64(ttl / 4);
        assert!(init(p.clone()).is_ok());
        p.min_answer = U64(ttl - 1);
        assert!(init(p).is_ok());
    }

    fn ctx_at(pred: &str, signer: &PublicKey, t: u64, balance: NearToken) {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        testing_env!(VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id(pred.parse().unwrap())
            .signer_account_pk(signer.clone())
            .block_timestamp(t)
            .account_balance(balance)
            .build());
    }

    fn panics(f: impl FnOnce()) -> String {
        let e =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("call must panic");
        e.downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    // V23-06: acks have their own rolling 24 h budget and never spend the decision budget.
    #[test]
    fn acks_have_their_own_daily_budget() {
        let t = 20_000 * DAY_NS;
        let (mut c, pk) = armed_at(t);
        c.policy.max_decisions_per_day = 2;
        let rich = NearToken::from_near(100);
        let root = "ab".repeat(32);
        for i in 0..=MAX_ACKS_PER_DAY as u64 {
            ctx_at("owner.testnet", &pk, t + i, rich);
            c.release(U64(t + i), root.clone(), 1);
        }
        for i in 0..MAX_ACKS_PER_DAY as u64 {
            ctx_at("vault.testnet", &pk, t + i, rich);
            assert!(c.ack(U64(t + i), root.clone()));
        }
        assert_eq!(c.decisions_today, 0);
        let last = MAX_ACKS_PER_DAY as u64;
        ctx_at("vault.testnet", &pk, t + last, rich);
        let err = panics(|| {
            c.ack(U64(t + last), root.clone());
        });
        assert!(err.contains("ack limit reached"), "{err}");
        c.decline(hex::encode([1u8; 32]), "no".into());
        // a day after the first ack, the budget is back
        ctx_at("vault.testnet", &pk, t + DAY_NS, rich);
        assert!(c.ack(U64(t + last), root));
        assert_eq!(c.stats.acks_matched, MAX_ACKS_PER_DAY as u32 + 1);
        assert_eq!(c.stats.releases_posted, MAX_ACKS_PER_DAY as u32 + 1);
    }

    // V23-04 and V23-07: who acked, when, and whether the agent could still act.
    #[test]
    fn delivery_needs_an_undecided_invoice_and_an_able_agent() {
        let t = 20_000 * DAY_NS;
        let (base, pk) = armed_at(t);
        let id = [0x42u8; 32];
        let root = hex::encode(merkle_leaf(&id));
        let slot = TestSlot {
            commitment: String::new(),
            batch: 0,
            committed_at: U64(t),
            expires_at: U64(t + 60_000_000_000),
            tlock_round: 0,
            ciphertext_sha256: String::new(),
            status: TestStatus::Committed,
            contained: false,
            demoted: false,
            reveal: None,
        };
        let dl = Delivery {
            release_at: U64(t + 1),
            index: 0,
            proof: vec![],
        };
        let rich = NearToken::from_near(100);
        let mut c = base;
        ctx_at("owner.testnet", &pk, t + 1, rich);
        c.release(U64(t + 1), root.clone(), 1);
        ctx_at("vault.testnet", &pk, t + 2, rich);
        assert!(c.ack(U64(t + 1), root));
        let deadline = t + 45_000_000_000;
        let check = |c: &Shop| {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                c.check_delivery(&slot, &hex::encode(id), &dl)
            }));
            r.err()
                .map(|e| e.downcast_ref::<String>().cloned().unwrap_or_default())
        };
        assert_eq!(check(&c), None, "the baseline delivery holds");
        c.releases.flush();

        type Gap<'a> = Box<dyn Fn(&mut Shop) + 'a>;
        let gaps: Vec<(&str, Gap)> = vec![
            (
                "not ignored",
                Box::new(|c: &mut Shop| {
                    // decided before the commit, outside the window
                    c.decisions.insert(
                        hex::encode(id),
                        Decision {
                            kind: DecisionKind::Declined,
                            payee: None,
                            payee_approved: false,
                            amount: U128(0),
                            at: U64(t - 1),
                            key: c.agent_key.clone().unwrap(),
                            ref_id: 0,
                        },
                    );
                }),
            ),
            (
                "unarmed or frozen",
                Box::new(|c: &mut Shop| c.mode = Mode::Frozen),
            ),
            (
                "unarmed or frozen",
                Box::new(|c: &mut Shop| c.mode = Mode::Unarmed),
            ),
            (
                "another key",
                Box::new(|c: &mut Shop| {
                    c.agent_key = Some(
                        "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847"
                            .parse()
                            .unwrap(),
                    )
                }),
            ),
            (
                "predates the current arming",
                Box::new(|c: &mut Shop| c.armed_at = U64(t + 3)),
            ),
            (
                "frozen inside the answer window",
                Box::new(|c: &mut Shop| c.frozen_at = U64(t + 3)),
            ),
            (
                "frozen inside the answer window",
                Box::new(move |c: &mut Shop| c.frozen_at = U64(deadline)),
            ),
        ];
        for (i, (want, gap)) in gaps.into_iter().enumerate() {
            let mut g = Shop {
                decisions: LookupMap::new(format!("gap{i}").into_bytes()),
                ..clone_shop(&c)
            };
            gap(&mut g);
            let err = check(&g).expect(want);
            assert!(err.contains(want), "{want}: {err}");
        }
        // a freeze before the ack or after the deadline leaves the proof alone
        for at in [t + 1, deadline + 1] {
            let mut g = clone_shop(&c);
            g.frozen_at = U64(at);
            assert_eq!(check(&g), None, "frozen_at {at}");
        }
    }

    /// Shallow copy for one-field variations; collections share storage prefixes.
    fn clone_shop(c: &Shop) -> Shop {
        Shop {
            owner_id: c.owner_id.clone(),
            vendor_id: c.vendor_id.clone(),
            token_id: c.token_id.clone(),
            intents_id: c.intents_id.clone(),
            policy: c.policy.clone(),
            pending_limits: c.pending_limits.clone(),
            mode: c.mode,
            agent_key: c.agent_key.clone(),
            pending_key: c.pending_key.clone(),
            armed_at: c.armed_at,
            demoted_at: c.demoted_at,
            spend_window: c.spend_window.clone(),
            day: c.day,
            decisions_today: c.decisions_today,
            last_batch_at: c.last_batch_at,
            stats: c.stats.clone(),
            tests: Vector::new(Key::Tests),
            batches: Vector::new(Key::Batches),
            commitments: LookupSet::new(Key::Commitments),
            decisions: LookupMap::new(Key::Decisions),
            payments: Vector::new(Key::Payments),
            proposals: Vector::new(Key::Proposals),
            payees: LookupMap::new(Key::Payees),
            approved: IterableMap::new(Key::Approved),
            scored_decisions: LookupSet::new(Key::ScoredDecisions),
            paid: LookupSet::new(Key::Paid),
            registered: LookupSet::new(Key::Registered),
            open_from: c.open_from,
            open_slots: c.open_slots,
            stale_key: c.stale_key.clone(),
            releases: LookupMap::new(Key::Releases),
            frozen_at: c.frozen_at,
            ack_window: c.ack_window.clone(),
        }
    }

    // V23-08: an armed gas key reserves its demotion re-key; permissionless resync cannot spend the reserve.
    #[test]
    fn gas_key_rekey_is_reserved() {
        let t = 20_000 * DAY_NS;
        let (mut c, pk) = armed_at(t);
        let allowance = c.policy.key_allowance;
        let classic = c.reserve();
        c.policy.key_nonces = 4;
        assert_eq!(c.reserve(), classic.saturating_add(allowance));
        c.mode = Mode::Demoted;
        assert_eq!(c.reserve(), classic, "the demotion re-key is spent");
        c.stale_key = Some(pk.clone());
        let storage = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        ctx_at(
            "stranger.testnet",
            &pk,
            t,
            storage.saturating_add(NearToken::from_millinear(600)),
        );
        let err = panics(|| {
            let _ = c.resync_key();
        });
        assert!(err.contains("cannot fund the agent gas key"), "{err}");
    }

    // V23-10: a prior gas key may survive its DeleteKey, so arming must not forget it.
    #[test]
    fn arming_keeps_a_prior_gas_key_stale() {
        let t = 20_000 * DAY_NS;
        let (mut c, old) = armed_at(t);
        let new: PublicKey = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847"
            .parse()
            .unwrap();
        c.policy.key_nonces = 4;
        c.agent_key = Some(new.clone());
        c.stale_key = Some(old.clone());
        assert!(c.on_armed(new, Mode::Demoted, Some(old.clone()), U64(0), Ok(())));
        assert_eq!(c.stale_key, Some(old));
    }

    /// Test-side tree: sorted leaves, zero-padded to a power of two; returns every level, leaves first.
    fn merkle_levels(ids: &[[u8; 32]]) -> Vec<Vec<[u8; 32]>> {
        let mut ids = ids.to_vec();
        ids.sort();
        let mut leaves: Vec<[u8; 32]> = ids.iter().map(merkle_leaf).collect();
        leaves.resize(leaves.len().next_power_of_two(), [0u8; 32]);
        let mut levels = vec![leaves];
        while levels.last().unwrap().len() > 1 {
            let next = levels
                .last()
                .unwrap()
                .chunks(2)
                .map(|p| merkle_node(&p[0], &p[1]))
                .collect();
            levels.push(next);
        }
        levels
    }

    fn merkle_proof(levels: &[Vec<[u8; 32]>], index: usize) -> Vec<[u8; 32]> {
        let depth = levels.len() - 1;
        (0..depth).map(|d| levels[d][(index >> d) ^ 1]).collect()
    }

    // Shared vectors with the TypeScript tree; written to tests/fixtures/merkle.json for its parity test.
    #[test]
    fn merkle_vectors() {
        armed_at(0);
        let ids: Vec<[u8; 32]> = [0x11u8, 0x22, 0x33, 0x44]
            .iter()
            .map(|b| [*b; 32])
            .collect();
        let roots = [
            (
                1,
                "4635e1fa62a599a7880a8d14a56f720a1d40f6e5448ab5a5e39bedc8bd87fa8e",
            ),
            (
                3,
                "8456303a1e30d1ba174eaad8b4b111e5b98cd3715d1b989b2f19173446fe83ad",
            ),
            (
                4,
                "0bdd9ab2021b08e98613d9495870a4e3445ddc83e83bcff6a6d6f1ccd5120105",
            ),
        ];
        let mut vectors = Vec::new();
        for (count, want) in roots {
            let set = &ids[..count];
            let levels = merkle_levels(set);
            let root = levels.last().unwrap()[0];
            assert_eq!(hex::encode(root), want, "root for count {count}");
            assert_eq!(levels.len() - 1, merkle_depth(count as u32) as usize);
            let proofs: Vec<serde_json::Value> = (0..count)
                .map(|i| {
                    let p = merkle_proof(&levels, i);
                    assert_eq!(merkle_root_of(merkle_leaf(&set[i]), i as u32, &p), root);
                    serde_json::json!({
                        "index": i,
                        "invoice_id": hex::encode(set[i]),
                        "proof": p.iter().map(hex::encode).collect::<Vec<_>>(),
                    })
                })
                .collect();
            vectors.push(serde_json::json!({
                "count": count,
                "depth": merkle_depth(count as u32),
                "invoice_ids": set.iter().map(hex::encode).collect::<Vec<_>>(),
                "root": want,
                "proofs": proofs,
            }));
        }
        // count 1: the root is the leaf itself
        assert_eq!(hex::encode(merkle_leaf(&ids[0])), roots[0].1);
        // count 3, index 1 and 2 (index 3 is the zero pad)
        let three = merkle_levels(&ids[..3]);
        let hexs = |p: Vec<[u8; 32]>| p.iter().map(hex::encode).collect::<Vec<_>>();
        assert_eq!(
            hexs(merkle_proof(&three, 1)),
            [
                "4635e1fa62a599a7880a8d14a56f720a1d40f6e5448ab5a5e39bedc8bd87fa8e",
                "cd9983e108c3576842260b98a96d0ec222f48a20725a6408f41aa85b133f5b16"
            ]
        );
        assert_eq!(
            hexs(merkle_proof(&three, 2)),
            [
                "0000000000000000000000000000000000000000000000000000000000000000",
                "cc15b132263fd4fd2748c0e7cb9e1c4ad0afe70fcf9382ee644c4da8af0286a5"
            ]
        );
        // a wrong index or a swapped sibling misses the root
        let p = merkle_proof(&three, 1);
        assert_ne!(merkle_root_of(merkle_leaf(&ids[1]), 0, &p), three[2][0]);
        assert_ne!(merkle_depth(5), 2);
        let fixture = serde_json::json!({
            "leaf": "sha256(0x00 || invoice_id_bytes)",
            "node": "sha256(0x01 || left || right)",
            "padding": "leaves sorted ascending, padded with 32 zero bytes to the next power of two",
            "vectors": vectors,
        });
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/merkle.json");
        std::fs::write(path, serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
    }

    #[test]
    fn drand_rounds() {
        assert_eq!(drand_round_at(DRAND_GENESIS_S * 1_000_000_000), 1);
        assert_eq!(drand_round_at((DRAND_GENESIS_S + 3) * 1_000_000_000), 2);
        assert_eq!(drand_round_at(0), 0);
    }
}
