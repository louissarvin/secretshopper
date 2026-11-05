import { describe, expect, test } from 'bun:test';
import cron from 'node-cron';
import { COMMIT_CRON_RE, reconcileCommits, type StoppableTask } from '../src/tester/schedule.ts';

describe('per-vault commit schedules (ADR-5)', () => {
  test('reconcile adds, replaces on a cron change, keeps unchanged ones and stops removed ones', () => {
    const current = new Map<string, { cron: string; task: StoppableTask }>();
    const made: string[] = [];
    const stopped: string[] = [];
    const schedule = ({ shop, cron: c }: { shop: string; cron: string }) => {
      made.push(`${shop}@${c}`);
      return { stop: () => void stopped.push(`${shop}@${c}`) };
    };
    expect(reconcileCommits(current, [{ shop: 'a', cron: '0 0 * * *' }, { shop: 'b', cron: '0 6 * * *' }], schedule)).toEqual({ added: ['a', 'b'], replaced: [], stopped: [] });
    expect(reconcileCommits(current, [{ shop: 'a', cron: '0 0 * * *' }, { shop: 'b', cron: '30 6 * * *' }], schedule)).toEqual({ added: [], replaced: ['b'], stopped: [] });
    expect(reconcileCommits(current, [{ shop: 'b', cron: '30 6 * * *' }], schedule)).toEqual({ added: [], replaced: [], stopped: ['a'] });
    expect(made).toEqual(['a@0 0 * * *', 'b@0 6 * * *', 'b@30 6 * * *']);
    expect(stopped).toEqual(['b@0 6 * * *', 'a@0 0 * * *']);
    expect([...current.keys()]).toEqual(['b']);
  });

  test('a vault cron fires at most hourly: M H * * * only', () => {
    for (const ok of ['0 0 * * *', '15 */6 * * *', '5 1,13 * * *', '59 8-17 * * *']) {
      expect(COMMIT_CRON_RE.test(ok) && cron.validate(ok)).toBe(true);
    }
    for (const bad of ['* * * * *', '*/5 * * * *', '0 0 1 * *', '0 0 * * 1', '0 0 * * * *', '60 0 * * *', 'rm -rf']) {
      expect(COMMIT_CRON_RE.test(bad) && cron.validate(bad)).toBe(false);
    }
  });
});
