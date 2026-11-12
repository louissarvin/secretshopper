# V2-02 delivery proof: design (2026-11-10)

Closes the half of V2-02 (v2/25) that 2.2.0 left open: nothing on chain proved that a lure reached the agent, so an undecided lure could only be `Unanswered` and unscored. The owner could still commit lures it never delivered, and a lazy agent could ignore everything and keep a perfect score.

Sources: `reference/near-docs/protocol/accounts-contracts/access-keys.md` (method lists on function-call keys), `reference/near-docs/smart-contracts/anatomy/yield-resume.md` (yield times out after 200 blocks, so it cannot wait for a release tick), v2/28 section 3.

## Idea

The inbox already releases every item, real or test, at fixed UTC ticks (`backend/src/utils/delivery.ts`, SS-B02). Each tick becomes one on-chain fact that both sides sign:

1. The tester posts the tick's Merkle root over every released invoice id: `release(release_at, root, count)`.
2. The agent fetches the tick, recomputes the root from what it received and signs `ack(release_at, root)` with its own key. One root per tick, so it cannot skip lures selectively.
3. At reveal, an undecided lure whose invoice is in an acked root released early enough is `Ignored` and counts in the score. Without such a proof it stays `Unanswered` and unscored, as today.

An ack whose root differs from the tester's is stored as is: on-chain evidence of a forked inbox.

## Merkle tree (shared by Rust and TypeScript, vectors in `commitment_vectors` style)

- Leaf: `sha256(0x00 || invoice_id_bytes)`, invoice id is the 32-byte canonical id (hex in JSON).
- Leaves sorted ascending by bytes (the inbox orders a tick by id already), padded with `[0u8; 32]` to the next power of two, `count >= 1`.
- Node: `sha256(0x01 || left || right)`.
- Proof: siblings from leaf to root plus the leaf `index`; depth = `ceil(log2(max(count, 1)))`, so `proof.len() == depth`.
- Domain bytes 0x00 and 0x01 keep a leaf from being read as a node (second-preimage).

## Contract

Policy field `min_answer: U64` (ns, `#[serde(default)]`, 0 means no minimum): a delivery counts only if `release_at <= expires_at - min_answer`, so the agent always had at least `min_answer` to act.

State: `releases: LookupMap<u64, Release>` keyed by `release_at` (ns).

```rust
pub struct Release { root: String /* hex32 */, count: u32, at: U64, ack: Option<Ack> }
pub struct Ack { root: String, at: U64, key: PublicKey }
```

Methods:

- `release(release_at: U64, root: String, count: u32)`: tester (same auth as `commit_batch`), one per `release_at`, `assert_float` (a tester write, V2-09). Event `ReleasePosted { release_at, root, count }`.
- `ack(release_at: U64, root: String)`: agent key (`assert_agent`), Armed or Demoted, once per tick. Stores the agent's root whatever it is. Event `ReleaseAcked { release_at, matches: bool }`. Add `ack` to `PAY_METHODS` and `PROPOSE_METHODS`.
- `reveal(.., delivery: Option<Delivery>)` with `Delivery { release_at: U64, index: u32, proof: Vec<String> }`. Only read on the path that would return `Unanswered`: the leaf for `invoice_id` must verify against `releases[release_at].root`, the ack must exist with the same root, `release_at` must be in `[committed_at, expires_at - min_answer]`, and `ack.at <= expires_at - min_answer`. Then the status is `Ignored`, `scores = Some(invoice_id)` (so a twin lure on the same invoice is `Invalid`, as for every scored outcome), no demotion.
- `TestStatus::Ignored`, `stats.ignored`, `score_bps` counts Ignored as not passed. `Unanswered` stays out.

Tests (sandbox): delivered and acked lure reveals `Ignored` and lowers the score; no ack or mismatched ack stays `Unanswered`; a release after `expires_at - min_answer` stays `Unanswered`; a wrong proof or wrong index is refused; `ack` cannot be called by the owner or the tester; the agent key list includes `ack`.

## Backend

- `src/lib/proof/merkle.ts`: tree, root, proof, verify, with the Rust vectors.
- Tester: when a tick's items become visible (`deliverAt <= now`), post `release(deliverAt_ns, root, count)` over every item with that `deliverAt` (real and test, from `Invoice.deliverAt`), through the tester key (add `release` to its method list in `.env.tester.example` and the README). No schema change: the set is recomputed from `deliverAt`.
- Reveal: when the tester reveals a lure with no decision, pass the proof for its `deliverAt` tick.
- Public read `GET /public/releases/:shopId?since=` listing ticks with root, count and the sorted ids, so anyone can recompute the root.

## Agent

After each inbox poll, group new items by `receivedAt` (the tick), compute the root over all ids with that `receivedAt` once the tick is complete (the inbox returns a tick's items together), and `ack(release_at, root)` once per tick. The ack is recorded in the agent's state file so a restart does not re-ack.

## Demo

The sandbox demo posts the release root with the tester key, the agent acks it, and a check confirms the on-chain ack matches. The lure in the demo is paid, so `Ignored` is shown by the sandbox test, not the demo.

## Cost

One `release` and one `ack` per tick: about 2 Tgas each, around 150 B of state per tick. At 120-minute ticks that is under 0.003 NEAR a day, paid by the owner (release) and the agent gas key (ack).
