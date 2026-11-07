/**
 * `bun multi-vault-e2e.ts`: v2/37 on a local sandbox. One owner holds two vaults (v1 the default, v2 self-serve),
 * registers both through the API, adds both tester keys on the same account (one per vault, ADR-2), enables testing
 * on v2, runs one tester cycle through the real per-vault jobs, then removes v2's key and checks only v2 stops.
 *
 * Needs: contracts/shop/target/near/secret_shopper.wasm, the tUSDC fixture wasm, drand quicknet (tlock), and
 * TEST_DATABASE_URL pointing at a throwaway Postgres whose schema was created with `prisma db push`. It writes rows
 * there and removes the ones it made. Never point it at a real database.
 * Env (optional): DEMO_SANDBOX_VERSION (default 2.14.0), MV_TEST_TTL_S (default 240).
 * Expected last line: PASS: multi-vault checks held
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tearDownSandbox } from './lib/sandbox.ts';

const ROOT = resolve(import.meta.dir, '..');
const SHOP_WASM = join(ROOT, 'contracts/shop/target/near/secret_shopper.wasm');
const FT_WASM = join(ROOT, 'contracts/shop/tests/fixtures/ft/target/near/fungible_token.wasm');
const DB = process.env.TEST_DATABASE_URL;

const missing: string[] = [];
if (!existsSync(SHOP_WASM)) missing.push(`vault wasm missing: ${SHOP_WASM} (cd contracts/shop && cargo near build non-reproducible-wasm)`);
if (!existsSync(FT_WASM)) missing.push(`tUSDC fixture wasm missing: ${FT_WASM}`);
if (!DB) missing.push('TEST_DATABASE_URL is not set (a throwaway Postgres with the schema pushed)');
try {
  const r = await fetch('https://api.drand.sh/v2/beacons/quicknet/info', { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(String(r.status));
} catch (e) {
  missing.push(`drand quicknet unreachable (tlock sealing needs it): ${(e as Error).message}`);
}
if (missing.length) {
  console.error('Prerequisites missing:\n' + missing.map((m) => '- ' + m).join('\n'));
  process.exit(1);
}

const TTL_S = Number(process.env.MV_TEST_TTL_S || 240);
const T0 = Date.now();
let checks = 0;
const fails: string[] = [];
const expect = (ok: boolean, what: string) => {
  console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (ok) checks++;
  else fails.push(what);
};

const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = await import('near-sandbox');
const sandbox = await Sandbox.start({ version: process.env.DEMO_SANDBOX_VERSION || '2.14.0', config: { additionalConfig: { gc_num_epochs_to_keep: 1000 } } });
const { Account, JsonRpcProvider, KeyPair, PublicKey, actions, baseEncode, nearToYocto, teraToGas } = await import('near-api-js');
type KeyPairString = import('near-api-js').KeyPairString;

const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
const ownerId = `o1.${DEFAULT_ACCOUNT_ID}`;
const vendorId = `vendor.${DEFAULT_ACCOUNT_ID}`;
const ft = `tusdc.${DEFAULT_ACCOUNT_ID}`;
const v1 = `v1.${ownerId}`;
const v2 = `v2.${ownerId}`;
const wasm = new Uint8Array(readFileSync(SHOP_WASM));
const digest = new Uint8Array(createHash('sha256').update(wasm).digest());

// FastNEAR tx API stand-in: registration asks it for a vault's first received tx (its creation tx).
const created = new Map<string, { hash: string; height: number }>();
const txApi = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as { account_id?: string };
    const c = new URL(req.url).pathname === '/v0/account' && body.account_id ? created.get(body.account_id) : undefined;
    return Response.json({ account_txs: c ? [{ transaction_hash: c.hash, tx_block_height: c.height }] : [], resume_token: null });
  },
});

// Every backend module reads its config at import, so set the env for both the API and the tester first.
const testerKp = KeyPair.fromRandom('ed25519'); // v1 (default vault) tester key, as TESTER_PRIVATE_KEY
Object.assign(process.env, {
  NEAR_NETWORK: 'testnet',
  NEAR_RPC_URL: sandbox.rpcUrl,
  NEAR_RPC_URLS: sandbox.rpcUrl,
  NEAR_TX_API_URL: `http://127.0.0.1:${txApi.port}`,
  DATABASE_URL: DB,
  LOG_LEVEL: 'warn',
  JWT_SECRET: randomBytes(32).toString('hex'),
  INBOX_TOKEN_HASH: createHash('sha256').update(randomBytes(24)).digest('hex'),
  SHOP_CONTRACT_ID: v1,
  VAULT_CODE_HASH: baseEncode(digest),
  RELEASE_TICK_MINUTES: '1',
  TESTER_ACCOUNT_ID: ownerId,
  TESTER_PRIVATE_KEY: testerKp.toString(),
  USDC_CONTRACT_ID: ft,
  TEST_SEAL_KEY: randomBytes(32).toString('hex'),
  TESTER_KEY_SEED: randomBytes(32).toString('hex'),
  NEARAI_API_KEY_TESTER: '', // void batches only: no NEAR AI spend
});

let exitCode = 1;
let cleanup: () => Promise<void> = async () => {};
try {
  const { prismaQuery: prisma } = await import('../backend/src/lib/prisma.ts');
  const { buildApp } = await import('../backend/src/app.ts');
  const { TESTER_METHODS } = await import('../backend/src/lib/proof/testerKey.ts');
  const { getTests, getStatus } = await import('../backend/src/lib/near/shop.ts');
  const { chainNowMs } = await import('../backend/src/lib/near/client.ts');
  const { contexts, preflight, provisionKeys } = await import('../backend/src/tester/vaults.ts');
  const { commitBatch, postReleases, revealWatcher } = await import('../backend/src/tester/workers.ts');
  const { signMessage } = await import('near-api-js/nep413');

  const call = (signer: InstanceType<typeof Account>, contractId: string, methodName: string, args: object, deposit = 0n) =>
    signer.callFunctionRaw({ contractId, methodName, args: args as Record<string, unknown>, deposit, gas: teraToGas(50), waitUntil: 'FINAL' });
  const newAccount = async (id: string, near: string) => {
    const kp = KeyPair.fromRandom('ed25519');
    await root.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(near as `${number}`) });
    return new Account(id, provider, kp.toString());
  };

  // 1. Accounts, token, global vault code, two vaults owned by o1
  const owner = await newAccount(ownerId, '60');
  const vendor = await newAccount(vendorId, '10');
  const ftAcct = await newAccount(ft, '10');
  await ftAcct.signAndSendTransaction({
    receiverId: ft,
    actions: [
      actions.deployContract(new Uint8Array(readFileSync(FT_WASM))),
      actions.functionCall('new', { owner_id: ownerId, total_supply: '1000000000', metadata: { spec: 'ft-1.0.0', name: 'Test USDC (sandbox only)', symbol: 'tUSDC', decimals: 6 } }, teraToGas(50), 0n),
    ],
    waitUntil: 'FINAL',
  });
  const hub = await newAccount(`codehub.${DEFAULT_ACCOUNT_ID}`, '40');
  await hub.signAndSendTransaction({ receiverId: hub.accountId, actions: [actions.deployGlobalContract(wasm, 'codeHash')], waitUntil: 'FINAL' });
  const ns = (s: number) => (BigInt(Math.round(s * 1000)) * 1_000_000n).toString();
  const policy = {
    daily_cap: '5000000', max_per_payment: '2000000', max_new_payees_per_day: 5, max_payments_per_day: 10, max_decisions_per_day: 20,
    batch_size: 2, batch_interval: '1', test_ttl: ns(TTL_S), min_answer: ns(Math.ceil(TTL_S / 4)), reveal_grace: ns(60),
    rearm_cooldown: ns(60), payee_delay: ns(2), limits_delay: ns(60), key_allowance: nearToYocto('0.25').toString(),
    storage_deposit: '1250000000000000000000', min_near_float: nearToYocto('0.5').toString(),
  };
  for (const id of [v1, v2]) {
    const out = await owner.signAndSendTransaction({
      receiverId: id,
      actions: [actions.createAccount(), actions.transfer(nearToYocto('5')), actions.useGlobalContract({ codeHash: digest }), actions.functionCall('new', { owner_id: ownerId, vendor_id: vendorId, token_id: ft, intents_id: null, policy }, teraToGas(50), 0n)],
      waitUntil: 'FINAL',
    });
    const block = await provider.viewBlock({ blockId: (out.transaction_outcome as unknown as { block_hash: string }).block_hash });
    created.set(id, { hash: out.transaction.hash, height: block.header.height });
  }
  expect((await getStatus(v1)).owner_id === ownerId && (await getStatus(v2)).owner_id === ownerId, 'o1 owns both vaults');

  // 2. API on the scratch database; o1 signs in with NEP-413 and registers both vaults
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const api = async <T>(method: string, path: string, o: { body?: unknown; token?: string; shop?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.shop ? { 'x-shop': o.shop } : {}) },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as { success: boolean; data: T; error: { code: string; message: string } | null } };
  };
  const nonce = await api<{ message: string; recipient: string; nonce: string }>('POST', '/auth/nonce', { body: { accountId: ownerId } });
  const signed = await signMessage({ signerAccount: owner, payload: { message: nonce.body.data.message, recipient: nonce.body.data.recipient, nonce: new Uint8Array(Buffer.from(nonce.body.data.nonce, 'base64')) } });
  const verify = await api<{ token: string }>('POST', '/auth/verify', {
    body: { accountId: ownerId, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString('base64'), nonce: nonce.body.data.nonce },
  });
  const token = verify.body.data.token;
  expect(verify.status === 200 && !!token, 'o1 signed in with NEP-413');

  const r1 = await api<{ id: string }>('POST', '/company', { token, body: { name: 'Vault one', deployBlock: created.get(v1)!.height } });
  const r2 = await api<{ id: string; createdTxHash: string }>('POST', '/company', { token, body: { name: 'Vault two', shopId: v2 } });
  expect(r1.status === 201 && r2.status === 201, `registered v1 (legacy body) and v2 (shopId): ${r1.status}, ${r2.status}`);
  expect(r2.body.data?.createdTxHash === created.get(v2)!.hash, 'v2 stored its creation tx');
  const companyIds = [r1.body.data?.id, r2.body.data?.id].filter(Boolean) as string[];
  cleanup = async () => {
    await prisma.sealedSlot.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.testSlot.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.testBatch.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.vendor.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    await prisma.authChallenge.deleteMany({ where: { accountId: ownerId } });
    await prisma.user.deleteMany({ where: { walletAddress: ownerId } });
  };

  // 3. Provisioner writes each vault's public key; o1 adds both keys to its own account
  await provisionKeys();
  const t1 = await api<{ publicKey: string }>('GET', `/public/tester/${v1}`);
  const t2 = await api<{ publicKey: string; methods: string[] }>('GET', `/public/tester/${v2}`);
  const pk1 = t1.body.data?.publicKey;
  const pk2 = t2.body.data?.publicKey;
  expect(pk1 === testerKp.getPublicKey().toString(), 'v1 shows the env tester key (TESTER_PRIVATE_KEY)');
  expect(!!pk2 && pk2 !== pk1, 'v2 shows its own derived key, different from v1');
  await owner.signAndSendTransaction({
    receiverId: ownerId,
    actions: [
      actions.addFunctionCallAccessKey(testerKp.getPublicKey(), v1, [...TESTER_METHODS], nearToYocto('1')),
      actions.addFunctionCallAccessKey(PublicKey.fromString(pk2!), v2, [...TESTER_METHODS], nearToYocto('1')),
    ],
    waitUntil: 'FINAL',
  });
  const ownerKeys = (await provider.viewAccessKeyList({ accountId: ownerId, finalityQuery: { finality: 'final' } })).keys.map((k) => k.public_key);
  expect(ownerKeys.includes(pk1!) && ownerKeys.includes(pk2!), 'one owner account holds a tester key for each of its two vaults');

  // 4. Vendors, an armed agent on v2, then testing enabled on v2 only
  const vendorBody = { legalName: 'Acme Hosting LLC', contactEmail: 'billing@acme.example', approvedPayees: [], sampleInvoices: [], styleSet: [] };
  const ven1 = await api('POST', '/vendors', { token, shop: v1, body: vendorBody });
  const ven2 = await api('POST', '/vendors', { token, shop: v2, body: vendorBody });
  expect(ven1.status === 201 && ven2.status === 201, 'one vendor on each vault');
  const agentKp = KeyPair.fromRandom('ed25519');
  await call(owner, v2, 'propose_key', { public_key: agentKp.getPublicKey().toString() }, 1n);
  await call(vendor, v2, 'accept_key', { public_key: agentKp.getPublicKey().toString() }, 1n);
  expect((await getStatus(v2)).mode === 'Armed', 'v2 agent armed (owner proposed, vendor accepted)');
  const def = await api<unknown>('PUT', '/company/tester', { token, shop: v1, body: { enabled: true } });
  expect(def.status === 409 && def.body.error?.code === 'DEFAULT_VAULT_ENV', 'the default vault cannot be toggled from the API');
  const en = await api<{ enabled: boolean }>('PUT', '/company/tester', { token, shop: v2, body: { enabled: true, testPercent: 0 } });
  expect(en.status === 200 && en.body.data?.enabled === true, `testing enabled on v2 at testPercent 0 (${en.status} ${en.body.error?.code ?? ''})`);

  // 5. One tester cycle through the per-vault jobs
  const ctxs = await contexts(true);
  const c1 = ctxs.find((c) => c.shop === v1)!;
  const c2 = ctxs.find((c) => c.shop === v2)!;
  expect(!!c1?.isDefault && !!c2 && !c2.isDefault && c2.enabled, 'tester serves v1 (default) and v2 (enabled)');
  expect((await preflight(c2, true)) === 'ok', 'v2 preflight ok: owner, key scope and allowance, armed, vendor, policy, float, capacity, budget');
  await commitBatch(c1, { testPercent: 0 });
  await commitBatch(c2);
  const [s1, s2] = await Promise.all([getTests(v1, 0, 10), getTests(v2, 0, 10)]);
  expect(s1.length === policy.batch_size && s2.length === policy.batch_size, `each vault got a batch of ${policy.batch_size}`);
  const batches = await prisma.testBatch.findMany({ where: { companyId: { in: companyIds } }, select: { companyId: true, txHash: true } });
  expect(batches.length === 2, 'one indexed batch row per vault');
  for (const b of batches) {
    const tx = await provider.viewTransactionStatus({ txHash: b.txHash, accountId: ownerId, waitUntil: 'FINAL' });
    const signerPk = (tx.transaction as unknown as { public_key: string }).public_key;
    const want = b.companyId === r1.body.data.id ? pk1 : pk2;
    expect(tx.transaction.signer_id === ownerId && signerPk === want, `${b.companyId === r1.body.data.id ? 'v1' : 'v2'} commit signed by o1 with that vault's own key`);
  }

  // 6. After expiry both vaults reveal their slots as Void
  const expiresMs = Number(BigInt(s2[0].expires_at) / 1_000_000n);
  console.log(`waiting ${Math.max(0, Math.ceil((expiresMs - (await chainNowMs())) / 1000))} s for expiry`);
  while ((await chainNowMs()) < expiresMs + 2_000) await Bun.sleep(3_000);
  await revealWatcher(c1);
  await revealWatcher(c2);
  await postReleases(c2); // no invoices on v2: posts nothing, must not throw
  const [after1, after2] = await Promise.all([getTests(v1, 0, 10), getTests(v2, 0, 10)]);
  expect(after1.every((s) => s.status === 'Void') && after2.every((s) => s.status === 'Void'), 'every slot on both vaults revealed Void');
  const p2 = await api<{ items: { slotIndex: number; revealed: boolean }[] }>('GET', `/public/tests/${v2}`);
  const p1 = await api<{ items: { slotIndex: number }[] }>('GET', `/public/tests/${v1}`);
  expect(p2.body.data.items.length === policy.batch_size && p2.body.data.items.every((s) => s.revealed), 'GET /public/tests/v2 lists v2 slots, revealed');
  expect(p1.body.data.items.length === policy.batch_size, 'GET /public/tests/v1 lists only v1 slots');

  // 7. v2's key removed: v2 alone stops; v1 keeps its state
  await owner.signAndSendTransaction({ receiverId: ownerId, actions: [actions.deleteKey(PublicKey.fromString(pk2!))], waitUntil: 'FINAL' });
  expect((await preflight(c2, true)) === 'key_missing', 'v2 preflight is key_missing after the owner removed its key');
  expect((await preflight(c1, false)) === 'ok', 'v1 is unaffected');
  const st = await api<{ state: string }>('GET', '/company/tester', { token, shop: v2 });
  expect(st.body.data?.state === 'key_missing', 'GET /company/tester shows key_missing for v2');

  exitCode = fails.length ? 1 : 0;
  await app.close();
} catch (error) {
  console.error('ERROR', error);
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', (e as Error).message));
  txApi.stop(true);
  await tearDownSandbox(sandbox);
}
if (exitCode === 0) console.log(`PASS: multi-vault checks held (${checks} checks)`);
else console.log(`FAIL: ${fails.length ? fails.join('; ') : 'aborted'}`);
process.exit(exitCode);
