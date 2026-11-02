-- SS-B04: the API process must not be able to read tester data. Run once as the database owner,
-- after `bun run db:push` (which creates schema "tester"). Replace the passwords; never commit real ones.
-- API .env:        DATABASE_URL=postgresql://ss_api:<pw>@host:5432/<db>?schema=public
-- tester .env.tester: DATABASE_URL=postgresql://ss_tester:<pw>@host:5432/<db>?schema=public
-- db:push keeps using the owner role.

CREATE ROLE ss_api LOGIN PASSWORD '<api password>';
CREATE ROLE ss_tester LOGIN PASSWORD '<tester password>';

-- API: public schema only. No usage on schema tester at all.
GRANT USAGE ON SCHEMA public TO ss_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ss_api;
REVOKE ALL ON SCHEMA tester FROM ss_api;
REVOKE ALL ON ALL TABLES IN SCHEMA tester FROM ss_api;
-- v1 rows may still hold sealed blobs and linkage in public.tests; hide those columns from the API.
REVOKE SELECT ON public.tests FROM ss_api;
GRANT SELECT ("id", "companyId", "slotIndex", "commitment", "status", "contained", "expiresAt", "batchIndex", "tlockRound",
              "ciphertextSha256", "receiptHash", "revealedPayee", "revealedSalt", "revealedInvoiceId", "revealTxHash",
              "revealedAt", "sweptTxHash", "createdAt", "updatedAt", "invoiceRowId", "aiReceiptId")
  ON public.tests TO ss_api;
GRANT UPDATE ("status", "contained", "expiresAt", "revealedPayee", "revealedSalt", "revealedInvoiceId", "revealTxHash", "revealedAt", "updatedAt")
  ON public.tests TO ss_api;

-- Tester: both schemas.
GRANT USAGE ON SCHEMA public, tester TO ss_tester;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ss_tester;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tester TO ss_tester;

-- Future tables created by db:push follow the same split.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ss_api, ss_tester;
ALTER DEFAULT PRIVILEGES IN SCHEMA tester GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ss_tester;

-- Multi-vault (v2/37): the API may not rewrite tester-written columns on companies.
REVOKE UPDATE ON public.companies FROM ss_api;
GRANT UPDATE ("name", "inboxTokenHash", "inboxTokenCreatedAt", "testerEnabled", "testerEnabledAt", "testerSignerId", "testPercent", "commitCron")
  ON public.companies TO ss_api;
