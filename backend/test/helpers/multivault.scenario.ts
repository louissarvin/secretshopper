// Run by test/multivault.route.test.ts in its own process (main-config is read once per process). Env: DATABASE_URL,
// SHOP_CONTRACT_ID, JWT_SECRET, INBOX_TOKEN_HASH, NEAR_RPC_URL(S) and NEAR_TX_API_URL pointing at the parent's stand-in,
// plus MV_TAG, MV_A2, MV_B1, MV_ALICE, MV_BOB, MV_ENV_TOKEN, MV_TESTER_PK. Prints one RESULT line of JSON.
import jwt from 'jsonwebtoken';
import { prismaQuery as db } from '../../src/lib/prisma.ts';
import { buildApp } from '../../src/app.ts';
import { projectVault } from '../../src/workers/shopProjector.ts';

const E = (k: string) => process.env[k]!;
const [TAG, DEFAULT, A2, B1, ALICE, BOB, ENV_TOKEN, TESTER_PK] = ['MV_TAG', 'SHOP_CONTRACT_ID', 'MV_A2', 'MV_B1', 'MV_ALICE', 'MV_BOB', 'MV_ENV_TOKEN', 'MV_TESTER_PK'].map(E);
const out: Record<string, unknown> = {};

// every route as registered, with the names of its preHandlers
const routes: { method: string; url: string; pre: string[] }[] = [];
const app = await buildApp({
  onRoute: (r) => {
    const pre = ([] as unknown[]).concat(r.preHandler ?? []).map((f) => (f as { name?: string }).name ?? '');
    for (const m of ([] as string[]).concat(r.method as string | string[])) routes.push({ method: m, url: r.url, pre });
  },
});
await app.ready();
out.routes = routes;

let ip = 0;
const call = async (method: string, url: string, o: { token?: string; shop?: string; body?: unknown; bearer?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`;
  if (o.shop !== undefined) headers['x-shop'] = o.shop;
  // a distinct client address per call, so per-IP rate limits never mix into the assertions
  const res = await app.inject({ method: method as 'GET', url, headers, payload: o.body as object, remoteAddress: `10.${(++ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}` });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body: body as { data: any; error: { code: string; message: string } | null } };
};

const userA = await db.user.create({ data: { walletAddress: ALICE } });
const userB = await db.user.create({ data: { walletAddress: BOB } });
const sign = (id: string) => jwt.sign({ userId: id }, E('JWT_SECRET'), { algorithm: 'HS256', expiresIn: '10m' });
const A = sign(userA.id);
const B = sign(userB.id);
const companyIds: string[] = [];

try {
  // registration: legacy default, self-serve a2 (Alice) and b1 (Bob)
  out.regDefault = await call('POST', '/company', { token: A, body: { name: 'Default Co', deployBlock: 1 } });
  out.regA2 = await call('POST', '/company', { token: A, body: { name: 'A two', shopId: A2 } });
  out.regA2Again = await call('POST', '/company', { token: A, body: { name: 'A two', shopId: A2 } });
  out.regA2ByBob = await call('POST', '/company', { token: B, body: { name: 'stolen', shopId: A2 } });
  out.regB1WithBlock = await call('POST', '/company', { token: B, body: { name: 'B one', shopId: B1, deployBlock: 5 } });
  out.regB1 = await call('POST', '/company', { token: B, body: { name: 'B one', shopId: B1 } });
  out.regUnknown = await call('POST', '/company', { token: B, body: { name: 'nobody', shopId: `nobody-${TAG}.testnet` } });
  const companies = await db.company.findMany({ where: { shopContractId: { in: [DEFAULT, A2, B1] } }, select: { id: true, shopContractId: true } });
  companyIds.push(...companies.map((c) => c.id));
  const cid = Object.fromEntries(companies.map((c) => [c.shopContractId, c.id]));

  out.mineA = await call('GET', '/company/mine', { token: A });
  out.mineB = await call('GET', '/company/mine', { token: B });
  out.meDefault = await call('GET', '/company/me', { token: A });
  out.meA2 = await call('GET', '/company/me', { token: A, shop: A2 });
  out.meBad = await call('GET', '/company/me', { token: A, shop: 'Bad..Id' });

  // cross-tenant matrix over every owner route
  const ownerRoutes: [string, string, unknown?][] = [
    ['GET', '/company/alerts'],
    ['POST', '/company/inbox-token'],
    ['PATCH', '/company/', { name: 'Taken Over Ltd' }],
    ['GET', '/company/tester'],
    ['PUT', '/company/tester', { enabled: false }],
    ['GET', '/vendors'],
    ['POST', '/vendors', {}],
    ['GET', '/invoices'],
    ['POST', '/invoices', {}],
    ['GET', '/tests'],
    ['GET', '/proposals'],
    ['POST', '/blocklist', {}],
  ];
  const matrix: Record<string, number[]> = {};
  for (const [m, u, body] of ownerRoutes) {
    matrix[`${m} ${u}`] = [
      (await call(m, u, { token: A, shop: B1, body })).status,
      (await call(m, u, { token: A, shop: `unknown-${TAG}.testnet`, body })).status,
      (await call(m, u, { token: A, shop: 'Not..Valid', body })).status,
      (await call(m, u, { token: B, body })).status,
    ];
  }
  out.matrix = matrix;
  out.renameA2 = await call('PATCH', '/company/', { token: A, shop: A2, body: { name: '  Larkspur Analytics  ' } });
  out.renameEmpty = await call('PATCH', '/company/', { token: A, shop: A2, body: { name: ' ' } });
  out.renameExtra = await call('PATCH', '/company/', { token: A, shop: A2, body: { name: 'X', shopContractId: B1 } });
  out.b1AfterRename = await call('GET', '/company/me', { token: B, shop: B1 });
  out.vendorsDefault = await call('GET', '/vendors', { token: A });
  out.vendorsA2 = await call('GET', '/vendors', { token: A, shop: A2 });

  // vendors and invoices for each vault, straight into the tables
  const vend = async (c: string, n: string) => db.vendor.create({ data: { companyId: c, legalName: n, contactEmail: `${n}@example.com`, approvedPayees: [], sampleInvoices: [], styleSet: {} }, select: { id: true } });
  const vA2 = await vend(cid[A2], 'a2vendor');
  const vB1 = await vend(cid[B1], 'b1vendor');
  const past = new Date(Date.now() - 60_000);
  const hex = (c: string) => c.repeat(64);
  await db.invoice.create({ data: { companyId: cid[A2], invoiceId: hex('a'), document: { n: 'a2' }, email: {}, deliverAt: past } });
  await db.invoice.create({ data: { companyId: cid[B1], invoiceId: hex('b'), document: { n: 'b1' }, email: {}, deliverAt: past } });
  await db.invoice.create({ data: { companyId: cid[DEFAULT], invoiceId: hex('d'), document: { n: 'default' }, email: {}, deliverAt: past } });

  // per-vault inbox token
  const issued = await call('POST', '/company/inbox-token', { token: A, shop: A2 });
  out.tokenIssued = issued;
  const t1 = (issued.body as { data: { token: string } }).data.token;
  out.whoamiA2 = await call('GET', '/inbox/whoami', { bearer: t1 });
  out.whoamiEnv = await call('GET', '/inbox/whoami', { bearer: ENV_TOKEN });
  out.nextA2 = await call('GET', '/inbox/next', { bearer: t1 });
  out.nextEnv = await call('GET', '/inbox/next', { bearer: ENV_TOKEN });
  out.vendorOwn = await call('GET', `/inbox/vendors/${vA2.id}`, { bearer: t1 });
  out.vendorForeign = await call('GET', `/inbox/vendors/${vB1.id}`, { bearer: t1 });
  out.wrongToken = await call('GET', '/inbox/whoami', { bearer: 'not-a-token' });
  const rotated = await call('POST', '/company/inbox-token', { token: A, shop: A2 });
  out.oldTokenAfterRotate = await call('GET', '/inbox/whoami', { bearer: t1 });
  out.newTokenAfterRotate = await call('GET', '/inbox/whoami', { bearer: (rotated.body as { data: { token: string } }).data.token });
  out.mineAfterToken = await call('GET', '/company/mine', { token: A });

  // blocklist: an agent counts its own vault and the trusted default, never an untrusted foreign vault
  const P = 'f'.repeat(64);
  for (const [vault, tx] of [[B1, 'TxB1'], [A2, 'TxA2'], [DEFAULT, 'TxDef']]) {
    await db.blocklistEntry.create({ data: { accountId: P, reason: 'r', evidenceTx: `${tx}-${TAG}`, evidenceKind: 'failed_reveal', reporterKind: 'tester', reporterId: 'x', vault, verified: true } });
  }
  const newToken = (rotated.body as { data: { token: string } }).data.token;
  out.blockA2 = await call('GET', `/inbox/blocklist/${P}`, { bearer: newToken });
  out.blockEnv = await call('GET', `/inbox/blocklist/${P}`, { bearer: ENV_TOKEN });
  out.blockPublic = await call('GET', `/public/blocklist/${P}`);

  // tester onboarding
  out.testerPublicBefore = await call('GET', `/public/tester/${A2}`);
  out.enableBeforeKey = await call('PUT', '/company/tester', { token: A, shop: A2, body: { enabled: true } });
  await db.company.update({ where: { id: cid[A2] }, data: { testerPublicKey: TESTER_PK } }); // what the tester's provisioner does
  out.enable = await call('PUT', '/company/tester', { token: A, shop: A2, body: { enabled: true, testPercent: 30, commitCron: '15 */6 * * *' } });
  out.badCron = await call('PUT', '/company/tester', { token: A, shop: A2, body: { enabled: true, commitCron: '* * * * *' } });
  out.enableDefault = await call('PUT', '/company/tester', { token: A, body: { enabled: true } });
  out.testerOwner = await call('GET', '/company/tester', { token: A, shop: A2 });
  out.disable = await call('PUT', '/company/tester', { token: A, shop: A2, body: { enabled: false } });
  out.a2Row = await db.company.findUnique({ where: { id: cid[A2] }, select: { testerEnabled: true, testerEnabledAt: true, testerSignerId: true, testPercent: true, commitCron: true, testerState: true, testerCheckedAt: true } });

  // projector: two vaults, one malformed row in a2 stays unprojected without blocking anything
  const ev = (contractId: string, n: number, data: object) =>
    db.contractEvent.create({ data: { receiptId: `mv-${TAG}-${n}`, logIndex: 0, txHash: 't', blockHeight: BigInt(100 + n), blockTime: new Date(), contractId, standard: 'secret_shopper', version: '2.3.0', event: 'paid', data } });
  const paid = (id: number) => ({ payment_id: id, invoice_id: 'c'.repeat(64), payee: 'p.testnet', amount: '1', rail: 'Near', by_owner: false });
  await ev(A2, 1, { broken: true });
  await ev(A2, 2, paid(7));
  await ev(B1, 3, paid(8));
  out.projected = [await projectVault(cid[A2], A2), await projectVault(cid[B1], B1)];
  out.payments = {
    a2: await db.payment.findMany({ where: { companyId: cid[A2] }, select: { paymentId: true } }),
    b1: await db.payment.findMany({ where: { companyId: cid[B1] }, select: { paymentId: true } }),
  };
  out.stuck = await db.contractEvent.count({ where: { receiptId: `mv-${TAG}-1`, projectedAt: null } });
} finally {
  await db.contractEvent.deleteMany({ where: { receiptId: { startsWith: `mv-${TAG}-` } } });
  await db.blocklistEntry.deleteMany({ where: { evidenceTx: { endsWith: `-${TAG}` } } });
  await db.payment.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.invoice.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.vendor.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  await db.$disconnect();
}
process.stdout.write('\nRESULT ' + JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
process.exit(0);
