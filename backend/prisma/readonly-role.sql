-- Read-only role for the hosted API (README, Deploy). Run once in the Neon SQL editor as the owner role, after
-- `bun run db:push` created the schema. Replace the password (Neon wants 60 bits of entropy); never commit it.
CREATE ROLE ss_ro WITH LOGIN PASSWORD '<read-only password>';

-- Only the tables the public routes read. No schema tester, no users, auth challenges or error logs.
GRANT USAGE ON SCHEMA public TO ss_ro;
GRANT SELECT ON public.companies, public.vendors, public.invoices, public.commitments, public.tests, public.payments,
  public.proposals, public.keys, public.ai_receipts, public.gen_log, public."ContractEvent", public."ChainCursor",
  public.blocklist_entries
  TO ss_ro;
REVOKE ALL ON SCHEMA tester FROM ss_ro;
