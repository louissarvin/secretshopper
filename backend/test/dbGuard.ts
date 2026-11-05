// Defense in depth for gated tests: refuse to write unless the shared Prisma client is on TEST_DATABASE_URL's database.
// test/setup.ts pins DATABASE_URL; this catches a client bound elsewhere (it once reached the development database).
export const assertTestDatabase = async (prisma: { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> }): Promise<void> => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set: refusing to touch any database');
  const want = decodeURIComponent(new URL(url).pathname.slice(1));
  const rows = (await prisma.$queryRaw`SELECT current_database() AS db`) as { db: string }[];
  if (rows[0]?.db !== want) throw new Error(`Prisma client is on database "${rows[0]?.db}", not TEST_DATABASE_URL's "${want}": refusing to write`);
};
