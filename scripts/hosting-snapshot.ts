// Copies what the hosted read-only API serves from the local database to the hosted one (README, Deploy).
//
//   SNAPSHOT_SOURCE_DATABASE_URL=...  SNAPSHOT_TARGET_DATABASE_URL=...  bun hosting-snapshot.ts --shop <vault> [--replace] [--dry-run]
//
// Public schema only, an explicit column list per table. Never copied: schema tester, users, auth challenges, error logs,
// vendor sample invoices and contact emails, the documents of invoices that are not revealed lures, receipts of
// unrevealed slots. The target schema must exist first (`bun run db:push` in backend/ against the target).
import { SQL } from 'bun';

type Spec = { table: string; cols: string; where: string };

// :companies = company ids, :shops = vault account ids, bound per query. Revealed means a reveal tx landed for the slot.
const REVEALED_INVOICE = `"invoiceId" IN (SELECT "revealedInvoiceId" FROM tests WHERE "revealedAt" IS NOT NULL AND "revealedInvoiceId" IS NOT NULL)`;
const ifRevealed = (col: string) => `CASE WHEN "revealedAt" IS NULL THEN NULL ELSE "${col}" END AS "${col}"`;
const byCompany = `"companyId" = ANY(:companies::text[])`;

// Insert order follows the foreign keys (everything points at companies).
const SPECS: Spec[] = [
  { table: 'companies', cols: `"id","ownerUserId","name","shopContractId","vendorAccountId","deployBlock","createdAt"`, where: `"id" = ANY(:companies::text[])` },
  {
    table: 'vendors',
    cols: `"id","companyId","legalName",'' AS "contactEmail","approvedPayees",'[]'::jsonb AS "sampleInvoices","styleSet","createdAt","updatedAt"`,
    where: byCompany,
  },
  {
    table: 'invoices',
    cols: `"id","companyId","invoiceId",CASE WHEN ${REVEALED_INVOICE} THEN "document" ELSE '{}'::jsonb END AS "document",CASE WHEN ${REVEALED_INVOICE} THEN "email" ELSE '{}'::jsonb END AS "email","deliverAt","createdAt"`,
    where: byCompany,
  },
  { table: 'commitments', cols: `"id","companyId","batchIndex","firstSlot","count","txHash","signerId","expiresAt","createdAt"`, where: byCompany },
  {
    table: 'tests',
    cols: [
      '"id","companyId","slotIndex","commitment"',
      ifRevealed('invoiceRowId'),
      ifRevealed('aiReceiptId'),
      '"batchIndex","tlockRound","ciphertextSha256"',
      ifRevealed('receiptHash'),
      '"status","contained","expiresAt","revealedPayee","revealedSalt","revealedInvoiceId","revealTxHash","revealedAt","sweptTxHash","createdAt","updatedAt"',
    ].join(','),
    where: byCompany,
  },
  { table: 'payments', cols: `"id","companyId","paymentId","invoiceId","payee","amount","rail","byOwner","status","receiptId","txHash","blockHeight","createdAt","updatedAt"`, where: byCompany },
  { table: 'proposals', cols: `"id","companyId","proposalId","invoiceId","payee","amount","status","receiptId","txHash","blockHeight","createdAt","updatedAt"`, where: byCompany },
  { table: 'keys', cols: `"id","companyId","publicKey","role","event","receiptId","txHash","blockHeight","createdAt"`, where: byCompany },
  {
    table: 'ai_receipts',
    cols: `"id","companyId","purpose","responseId","model","signatureKind","signingAlgo","signingAddress","signedText","signature","requestBody","responseBody","attestation","createdAt"`,
    where: `${byCompany} AND "id" IN (SELECT "aiReceiptId" FROM tests WHERE "revealedAt" IS NOT NULL AND "aiReceiptId" IS NOT NULL)`,
  },
  { table: 'gen_log', cols: `"id","companyId","batchIndex","position","receiptHash","model","accepted","createdAt"`, where: byCompany },
  {
    table: 'ContractEvent',
    cols: `"id","receiptId","logIndex","txHash","blockHeight","blockTime","contractId","standard","version","event","data","projectedAt","createdAt"`,
    where: `"contractId" = ANY(:shops::text[])`,
  },
  { table: 'ChainCursor', cols: `"id","blockHeight","updatedAt"`, where: 'true' },
  {
    table: 'blocklist_entries',
    cols: `"id","accountId","reason","evidenceTx","evidenceKind","reporterKind","reporterId","vault","verified","createdAt"`,
    where: `"vault" = ANY(:shops::text[])`,
  },
];

const CHUNK = 200;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
// connection strings must never reach the terminal, including inside driver errors
const redact = (s: string) => s.replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://<redacted>');
const pgArray = (xs: string[]) => `{${xs.join(',')}}`; // ids are cuids and account ids, both checked to need no quoting

/** Replaces :companies and :shops with positional parameters, so each query binds only what it uses. */
const bind = (query: string, values: Record<'companies' | 'shops', string>): [string, string[]] => {
  const args: string[] = [];
  const text = query.replace(/:(companies|shops)\b/g, (_m, name: 'companies' | 'shops') => {
    args.push(values[name]);
    return `$${args.length}`;
  });
  return [text, args];
};

const parseArgs = () => {
  const argv = process.argv.slice(2);
  const shops: string[] = [];
  let replace = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shop') shops.push(argv[++i] ?? fail('--shop needs a vault account id'));
    else if (a === '--replace') replace = true;
    else if (a === '--dry-run') dryRun = true;
    else fail(`unknown argument ${a}`);
  }
  if (!shops.length) fail('pass at least one --shop <vault account id>');
  for (const s of shops) if (s.length > 64 || !ACCOUNT_RE.test(s)) fail(`not a NEAR account id: ${s}`);
  return { shops, replace, dryRun };
};

const main = async () => {
  const { shops, replace, dryRun } = parseArgs();
  const sourceUrl = process.env.SNAPSHOT_SOURCE_DATABASE_URL ?? fail('SNAPSHOT_SOURCE_DATABASE_URL is not set');
  const targetUrl = process.env.SNAPSHOT_TARGET_DATABASE_URL ?? (dryRun ? '' : fail('SNAPSHOT_TARGET_DATABASE_URL is not set'));
  if (sourceUrl === targetUrl) fail('source and target are the same database');

  const source = new SQL(sourceUrl);
  const target = dryRun ? null : new SQL(targetUrl);
  try {
    const companies: { id: string; shopContractId: string }[] = await source.unsafe(`SELECT "id","shopContractId" FROM companies WHERE "shopContractId" = ANY($1::text[])`, [pgArray(shops)]);
    const missing = shops.filter((s) => !companies.some((c) => c.shopContractId === s));
    if (missing.length) fail(`not registered in the source database: ${missing.join(', ')}`);
    if (companies.some((c) => !/^[a-z0-9]+$/i.test(c.id))) fail('unexpected company id format');
    const values = { companies: pgArray(companies.map((c) => c.id)), shops: pgArray(shops) };

    const tables: { spec: Spec; rows: Record<string, unknown>[] }[] = [];
    for (const spec of SPECS) {
      const [{ rows }] = await source.unsafe(...bind(`SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text AS rows FROM (SELECT ${spec.cols} FROM "${spec.table}" WHERE ${spec.where}) x`, values));
      tables.push({ spec, rows: JSON.parse(rows) });
    }

    if (target) {
      for (const { spec } of tables) {
        const [{ reg }] = await target.unsafe(`SELECT to_regclass($1) AS reg`, [`public."${spec.table}"`]);
        if (!reg) fail(`target has no table public."${spec.table}"; run \`bun run db:push\` in backend/ against the target first`);
      }
      const nonEmpty: string[] = [];
      for (const { spec } of tables) {
        const [{ n }] = await target.unsafe(`SELECT count(*)::int AS n FROM "${spec.table}"`);
        if (n > 0) nonEmpty.push(spec.table);
      }
      if (nonEmpty.length && !replace) fail(`target already has rows in ${nonEmpty.join(', ')}; pass --replace to overwrite them`);

      await target.begin(async (tx) => {
        if (replace) await tx.unsafe(`TRUNCATE ${tables.map(({ spec }) => `"${spec.table}"`).join(', ')} CASCADE`);
        for (const { spec, rows } of tables) {
          if (!rows.length) continue;
          const cols = Object.keys(rows[0]).map((c) => `"${c}"`).join(',');
          for (let i = 0; i < rows.length; i += CHUNK) {
            await tx.unsafe(`INSERT INTO "${spec.table}" (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::"${spec.table}", ($1::text)::jsonb)`, [JSON.stringify(rows.slice(i, i + CHUNK))]);
          }
        }
      });
    }

    for (const { spec, rows } of tables) console.log(`${spec.table.padEnd(18)} ${String(rows.length).padStart(7)}`);
    console.log(dryRun ? `DRY RUN: nothing written (${shops.join(', ')}).` : `SNAPSHOT PASS: ${tables.reduce((n, t) => n + t.rows.length, 0)} rows copied for ${shops.join(', ')}.`);
  } finally {
    await source.close();
    await target?.close();
  }
};

main().catch((error: unknown) => fail(redact(error instanceof Error ? error.message : String(error))));
