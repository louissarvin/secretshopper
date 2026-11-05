// Preloaded before every test file (bunfig.toml). Bun loads backend/.env from cwd, and src/lib/prisma.ts binds the
// shared client to DATABASE_URL at import: whichever file imports it first decides the database for the whole run.
// Pin it here, so no test can ever reach the development database: the disposable TEST_DATABASE_URL, else nowhere.
const PROTECTED_DATABASES = new Set(['secretshopper_dev']);

const test = process.env.TEST_DATABASE_URL;
if (test) {
  let name = '';
  try {
    name = decodeURIComponent(new URL(test).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL');
  }
  if (PROTECTED_DATABASES.has(name)) throw new Error(`TEST_DATABASE_URL points at ${name}; tests run only on a disposable database`);
}
process.env.DATABASE_URL = test || 'postgresql://nobody:nobody@127.0.0.1:1/none';
