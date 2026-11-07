/**
 * verify-evidence (B10): re-checks a Secret Shopper vault from chain + drand + an evidence bundle.
 * The bundle (GET /public/evidence/:shop, or a file) is never trusted for anything the chain can say.
 * Usage: bun verify-evidence.ts <shop> <bundle.json | https://api.../public/evidence/<shop>> [--init-tx <hash>@<signer>] [--allow-unattested]
 *   --init-tx: the vault's creation tx when the FastNEAR tx API cannot find it (sandbox). --allow-unattested: report,
 *   but do not fail, a vault whose creation cannot be attested (classic deploys such as shop2).
 * Env: NEAR_NETWORK, NEAR_RPC_URL (use an archival RPC for old commit txs).
 * Prints PASS/FAIL per check; exit code = number of failures, or 100 if drand is unreachable (no verdict).
 */
import { readFileSync } from 'node:fs';
import { provider, view } from './lib/net.ts';
import { attestVault, chainNowMs, commitCallFromTx } from './lib/chainread.ts';
import { commitmentOf, receiptHashOf, ZERO_RECEIPT } from '../backend/src/lib/proof/commitment.ts';
import { invoiceIdOf } from '../backend/src/lib/proof/canonical.ts';
import { assuranceNote, assuranceOf, checkReceipt, type AiReceiptBytes } from '../backend/src/lib/proof/receipt.ts';
import { verifyReceiptAgainstAttestation } from '../backend/src/lib/proof/attestation.ts';
import { isVaultAgentScope, keyScope } from '../backend/src/lib/proof/accessKeys.ts';
import { ciphertextSha256, drandRoundAt, drandRoundTimeMs, DrandUnavailable, openFromChain, tlockRoundBounds } from '../backend/src/lib/proof/tlock.ts';
import type { EvidenceBundle } from '../backend/src/lib/evidence.ts';

type Slot = {
  commitment: string;
  batch: number;
  committed_at: string;
  expires_at: string;
  tlock_round: number;
  ciphertext_sha256: string;
  status: string;
  contained: boolean;
  reveal: { payee: string; invoice_id: string; receipt_hash: string; salt: string } | null;
};
type Batch = { first_slot: number; count: number; unrevealed: number };
type Scorecard = { stats: Record<string, number | string>; pending: number; overdue_unrevealed: number; score_bps: number | null };
type Decision = { kind: string; payee: string | null; at: string } | null;

const [shop, source] = process.argv.slice(2);
const initArg = process.argv[process.argv.indexOf('--init-tx') + 1];
const initTx = process.argv.includes('--init-tx') && initArg ? { hash: initArg.split('@')[0], signer: initArg.split('@')[1] } : undefined;
const allowUnattested = process.argv.includes('--allow-unattested');
if (!shop || !source) {
  console.error('usage: bun verify-evidence.ts <shop> <bundle.json | url>');
  process.exit(2);
}

const fails: string[] = [];
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(name);
  return ok;
};
const ns = (s: string) => Number(BigInt(s) / 1_000_000n);

const loadBundle = async (): Promise<EvidenceBundle> => {
  if (/^https?:\/\//.test(source)) {
    const page = async (url: string): Promise<EvidenceBundle> => {
      for (;;) {
        const res = await fetch(url);
        // the API allows 20 pages a minute per client
        if (res.status === 429) {
          await Bun.sleep(1000 * Math.min(60, Number(res.headers.get('retry-after')) || 10));
          continue;
        }
        const body = (await res.json()) as { data?: EvidenceBundle } & EvidenceBundle;
        return body.data ?? body;
      }
    };
    const first = await page(source);
    for (let next = first.next_from_slot; next != null; ) {
      const u = new URL(source);
      u.searchParams.set('fromSlot', String(next));
      const more = await page(u.toString());
      first.slots.push(...more.slots);
      next = more.next_from_slot;
    }
    return first;
  }
  return JSON.parse(readFileSync(source, 'utf8')) as EvidenceBundle;
};

const allTests = async (): Promise<Slot[]> => {
  const out: Slot[] = [];
  for (;;) {
    const page = await view<Slot[]>(shop, 'get_tests', { from: out.length, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
};

const bundle = await loadBundle();
check('bundle names this vault', bundle.shop === shop, `bundle.shop=${bundle.shop}`);

// 1. Vault identity: no full-access key; the agent key can only pay,decline or propose,decline (plus ack from 2.3.0) on the vault itself.
const acct = await provider.viewAccount({ accountId: shop });
console.log(`info code_hash ${acct.global_contract_hash ?? acct.code_hash}${acct.global_contract_hash ? ' (global contract by hash)' : ''}`);
const keys = (await provider.viewAccessKeyList({ accountId: shop, finalityQuery: { finality: 'final' } })).keys;
// GasKeyFullAccess is full access too; an unknown permission fails as well (C7).
const scopes = keys.map((k) => ({ pk: k.public_key, scope: keyScope(k.access_key.permission) }));
const notFc = scopes.filter((k) => k.scope.kind !== 'function_call');
check('1 no full-access key on the vault', notFc.length === 0, `${keys.length} key(s)${notFc.length ? `, not function-call: ${notFc.map((k) => k.scope.variant).join(',')}` : ''}`);
for (const { pk, scope } of scopes) {
  const detail = scope.kind === 'function_call' ? `${scope.variant} ${[...scope.methodNames].sort().join(',')}` : scope.variant;
  check(`1 key ${pk.slice(0, 16)}... scoped to the vault`, isVaultAgentScope(scope, shop), detail);
}

// 0. Provenance (V21-04): the vault's state started from a genuine `new`, so its views can be trusted.
const status = await view<{ owner_id: string; vendor_id: string; token_id: string; version: string }>(shop, 'get_status');
const att = await attestVault(shop, initTx);
if (att.ok) {
  check('0 vault created, given code by hash and initialized in one tx by its parent', true, att.txHash);
  check('0 the code attached at creation is the code the vault runs now', acct.global_contract_hash === att.codeHash, `${att.codeHash}`);
  check(
    '0 the initialized event matches the vault state',
    att.init?.owner_id === status.owner_id && att.init?.vendor_id === status.vendor_id && att.init?.token_id === status.token_id,
    `owner ${att.init?.owner_id}, version ${att.init?.version}`
  );
} else if (allowUnattested) {
  console.log(`WARN 0 provenance not attested (--allow-unattested): ${att.reasons.join('; ')}`);
} else {
  check('0 vault provenance attested', false, att.reasons.join('; '));
}

const chain = await allTests();
const graceMs = ns((await view<{ reveal_grace: string }>(shop, 'get_policy')).reveal_grace);
const now = await chainNowMs();
const drandRound = drandRoundAt(Date.now());

// Ciphertexts come only from commit tx args on chain; the bundle just says which txs to read.
const cts = new Map<string, string>();
for (const b of bundle.batches) {
  if (!b.tx || !b.signer_id) continue;
  try {
    for (const call of await commitCallFromTx(b.tx, b.signer_id, { shop, owner: status.owner_id }))
      call.slots.forEach((s, i) => call.ciphertexts[i] && cts.set(s.commitment, call.ciphertexts[i]));
  } catch (e) {
    check(`3 batch ${b.batch} commit tx is a successful owner call to this vault`, false, (e as Error).message);
  }
}

for (const [slotId, s] of chain.entries()) {
  const ev = bundle.slots.find((x) => x.slot === slotId);
  // 4. tlock: the round opens only after expiry and within the grace (V2-01); once public, anyone can open the slot.
  const b = tlockRoundBounds(ns(s.expires_at), graceMs);
  check(`4 slot ${slotId} tlock round opens after expiry, within the grace`, s.tlock_round >= b.min && s.tlock_round <= b.max, `round ${s.tlock_round} in [${b.min}, ${b.max}]`);
  // published and hash-matched can be proven at once; opening needs the round
  const ct = cts.get(s.commitment);
  const published = check(`4 slot ${slotId} ciphertext published in the commit tx`, !!ct) && !!ct;
  const hashed = published && check(`4 slot ${slotId} ciphertext sha256 matches chain`, ciphertextSha256(ct!) === s.ciphertext_sha256);
  if (hashed && drandRound >= s.tlock_round) {
    try {
      const p = await openFromChain(ct!);
      const opens = commitmentOf(p.salt, p.payee, p.invoice_id, p.receipt_hash) === s.commitment;
      check(`4 slot ${slotId} tlock opens to the committed preimage`, opens, opens ? (s.status === 'Committed' ? 'unrevealed: a keeper can reveal it now' : '') : 'OWNER SABOTAGE');
    } catch (e) {
      if (e instanceof DrandUnavailable) {
        // a network fault proves nothing either way; refuse to give a verdict
        console.error(`INCONCLUSIVE: ${e.message}`);
        process.exit(100);
      }
      check(`4 slot ${slotId} tlock opens`, false, `OWNER SABOTAGE: ${(e as Error).message}`);
    }
  } else if (hashed) {
    console.log(`info slot ${slotId} tlock round ${s.tlock_round} not yet public (now ${drandRound}); opens at ${new Date(drandRoundTimeMs(s.tlock_round)).toISOString()}`);
  }

  if (s.status === 'Committed') continue;
  // 2. Revealed slot: the chain's reveal recomputes to the chain's commitment; the bundle must agree.
  const r = s.reveal!;
  check(`2 slot ${slotId} chain reveal matches commitment`, commitmentOf(r.salt, r.payee, r.invoice_id, r.receipt_hash) === s.commitment, s.status);
  if (ev?.preimage) {
    check(`2 slot ${slotId} bundle preimage equals chain reveal`, JSON.stringify(ev.preimage) === JSON.stringify({ salt: r.salt, payee: r.payee, invoice_id: r.invoice_id, receipt_hash: r.receipt_hash }));
  } else {
    check(`2 slot ${slotId} bundle has the revealed slot`, false);
  }
  if (!r.payee) continue; // void

  // 3. Receipt and invoice bound by the commitment.
  if (ev?.invoice) check(`3 slot ${slotId} invoice_id = sha256(canonical(document))`, invoiceIdOf(ev.invoice.document) === r.invoice_id);
  if (r.receipt_hash === ZERO_RECEIPT) {
    console.log(`info slot ${slotId} has no AI receipt bound (scripted lure)`);
  } else if (check(`3 slot ${slotId} AI receipt present`, !!ev?.receipt) && ev?.receipt) {
    const rc = ev.receipt;
    const bytes: AiReceiptBytes = {
      responseId: rc.response_id,
      model: rc.model,
      signatureKind: rc.signature_kind as 'provider_tee' | 'gateway',
      signingAlgo: rc.signing_algo,
      signingAddress: rc.signing_address,
      signedText: rc.signed_text,
      signature: rc.signature,
      requestBody: rc.request_body,
      responseBody: rc.response_body,
    };
    const res = checkReceipt(bytes);
    check(`3 slot ${slotId} receipt bytes match signed text and signer`, res.ok, `text ${res.textMatches}, signer ${res.signerMatches}${res.error ? `, ${res.error}` : ''}`);
    // the bundle's own assurance label is ignored; it is recomputed from the bytes and the stored attestation
    let bound = false;
    if (rc.attestation) {
      const b = verifyReceiptAgainstAttestation(bytes, rc.attestation);
      bound = check(`3 slot ${slotId} receipt signer is the key in the stored ${rc.attestation.kind} attestation`, b.ok, b.error ?? '');
    }
    console.log(`info slot ${slotId} receipt assurance: ${assuranceNote(assuranceOf(bytes.signatureKind === 'provider_tee' ? 'provider_tee' : 'gateway', bound))}`);
    check(`3 slot ${slotId} receipt_hash = sha256(signed_text)`, receiptHashOf(rc.signed_text) === r.receipt_hash);
    check(`3 slot ${slotId} AI response names the payee`, rc.response_body.includes(r.payee));
  }

  // 5. Timeline: committed < delivered < decided <= expiry; decision read from chain.
  const d = await view<Decision>(shop, 'get_decision', { invoice_id: r.invoice_id });
  if (ev?.invoice) {
    const delivered = Date.parse(ev.invoice.deliver_at);
    check(`5 slot ${slotId} delivered after commit and before expiry`, delivered > ns(s.committed_at) && delivered < ns(s.expires_at), ev.invoice.deliver_at);
    if (d) check(`5 slot ${slotId} decision after delivery`, ns(d.at) >= delivered, `${d.kind} at ${new Date(ns(d.at)).toISOString()}`);
  }
}

// 6. Generation log: every revealed test's receipt is in its batch's published log.
const batches: Batch[] = [];
for (;;) {
  const page = await view<Batch[]>(shop, 'get_batches', { from: batches.length, limit: 100 });
  batches.push(...page);
  if (page.length < 100) break;
}
for (const b of bundle.batches) {
  const tests = chain.slice(b.first_slot, b.first_slot + b.count).filter((s) => s.reveal && s.reveal.receipt_hash !== ZERO_RECEIPT);
  if (tests.length === 0) continue;
  if (!b.gen_log) {
    console.log(`info batch ${b.batch} generation log not published yet (${batches[b.batch]?.unrevealed ?? '?'} unrevealed)`);
    continue;
  }
  const logged = new Set(b.gen_log.map((g) => g.receipt_hash));
  check(`6 batch ${b.batch} every test receipt is in the generation log`, tests.every((s) => logged.has(s.reveal!.receipt_hash)), `${b.gen_log.length} attempts for ${tests.length} test(s)`);
}

// 7. Stats recomputed from chain slots equal the contract scorecard.
const sc = await view<Scorecard>(shop, 'get_scorecard');
const count = (f: (s: Slot) => boolean) => chain.filter(f).length;
const recomputed = {
  committed: chain.length,
  passed: count((s) => s.status === 'Passed'),
  failed: count((s) => s.status === 'Failed' && !s.contained),
  failed_contained: count((s) => s.status === 'Failed' && s.contained),
  unanswered: count((s) => s.status === 'Unanswered'),
  ignored: count((s) => s.status === 'Ignored'),
  misdirected: count((s) => s.status === 'Misdirected'),
  void: count((s) => s.status === 'Void'),
  invalid: count((s) => s.status === 'Invalid'),
};
for (const [k, v] of Object.entries(recomputed)) check(`7 stats.${k} recomputed from slots`, Number(sc.stats[k] ?? 0) === v, `${v}`); // 2.0.x has no misdirected, before 2.3.0 no ignored
// 2.3.0 delivery-proof counters: not derivable from slots, so only their presence is checked
const [vMajor, vMinor] = status.version.split('.').map(Number);
if (vMajor > 2 || (vMajor === 2 && vMinor >= 3)) {
  for (const k of ['releases_posted', 'acks_matched', 'acks_mismatched']) {
    const v = sc.stats[k];
    check(`7 stats.${k} present`, typeof v === 'number' && Number.isInteger(v) && v >= 0, `${v}`);
  }
}
// the bundle's labels are what a reader sees first; any that contradict the chain fail
for (const [slotId, s] of chain.entries()) {
  const claimed = bundle.slots.find((x) => x.slot === slotId)?.status;
  if (s.status !== 'Committed') check(`7 slot ${slotId} bundle status matches chain`, claimed === s.status, `chain ${s.status}, bundle ${claimed ?? 'missing'}`);
  else if (claimed !== undefined && claimed !== 'Committed') check(`7 slot ${slotId} bundle status matches chain`, false, `chain Committed, bundle ${claimed}`);
}
check('7 pending + overdue = unrevealed slots', sc.pending + sc.overdue_unrevealed === count((s) => s.status === 'Committed'));
// unanswered is shown but not scored (no delivery proof); ignored had an acked release proof and scores as not passed
const denom = recomputed.passed + recomputed.failed + recomputed.failed_contained + recomputed.ignored;
check('7 score_bps = passed / (passed + failed + failed_contained + ignored)', sc.score_bps === (denom ? Math.floor((recomputed.passed * 10_000) / denom) : null), `${sc.score_bps}`);
console.log(`info chain time ${new Date(now).toISOString()}, drand round ${drandRound}`);

console.log(fails.length ? `\n${fails.length} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(fails.length);
