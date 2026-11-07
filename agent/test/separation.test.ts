import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The agent never gets database credentials and never imports backend code (16b §5.3).
const root = join(import.meta.dir, '..');
const DB_VAR = ['DATABASE', 'URL'].join('_'); // built so this file does not contain the literal

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.git') return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe('agent separation', () => {
  const sources = files(root).filter((f) => /\.(ts|json|example)$/.test(f) || f.endsWith('.env.example'));

  test('no file references the database URL variable', () => {
    expect(sources.filter((f) => readFileSync(f, 'utf8').includes(DB_VAR))).toEqual([]);
  });

  test('no import reaches into backend/', () => {
    expect(sources.filter((f) => /from ['"][^'"]*backend\//.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
