import { afterEach, describe, expect, test } from 'bun:test';
import { assertTestDatabase } from './dbGuard.ts';

// The guard every gated suite runs before its first write.
const on = (db: string) => ({ $queryRaw: async () => [{ db }] });
const saved = process.env.TEST_DATABASE_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = saved;
});

describe('assertTestDatabase', () => {
  test('passes only when the client is on the database TEST_DATABASE_URL names', async () => {
    process.env.TEST_DATABASE_URL = 'postgresql://u@127.0.0.1:5432/ss_scratch_1?schema=public';
    await assertTestDatabase(on('ss_scratch_1'));
    await expect(assertTestDatabase(on('secretshopper_dev'))).rejects.toThrow('refusing to write');
  });

  test('refuses outright without TEST_DATABASE_URL', async () => {
    delete process.env.TEST_DATABASE_URL;
    await expect(assertTestDatabase(on('anything'))).rejects.toThrow('TEST_DATABASE_URL is not set');
  });
});
