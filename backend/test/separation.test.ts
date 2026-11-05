import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

const lint = (filename: string, code: string) => {
  const p = Bun.spawnSync(['bunx', 'eslint', '--stdin', '--stdin-filename', filename], { cwd: root, stdin: Buffer.from(code) });
  return { code: p.exitCode, out: p.stdout.toString() };
};

describe('API cannot import tester code (16b §5.3)', () => {
  test('a route importing src/tester fails lint', () => {
    const r = lint('src/routes/evil.ts', "import { unseal } from '../tester/seal.ts';\nexport const x = unseal;\n");
    expect(r.code).toBe(1);
    expect(r.out).toContain('no-restricted-imports');
  });

  test('index.ts importing the tester fails lint', () => {
    expect(lint('index.ts', "import './src/tester/workers.ts';\n").code).toBe(1);
  });

  test('the tester itself may import its own modules', () => {
    expect(lint('src/tester/x.ts', "import { seal } from './seal.ts';\nexport const x = seal;\n").code).toBe(0);
  });
});
