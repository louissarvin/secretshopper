import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { parseB1Summary, parsePassRate, parseRunIndex, type B1Summary, type ModelRun } from './modelRuns.ts';
import { createLogger, errFields } from '../utils/logger.ts';

// Reads the committed measurement files; parsing is in modelRuns.ts.

const log = createLogger('model-runs');
const PASS_RATE_RE = /^pass-rate-.+\.json$/;
const ROOT = resolve(import.meta.dir, '../../..');

export interface ModelRuns {
  runs: ModelRun[];
  source: string[];
  b1: (B1Summary & { source: string }) | null;
}

// repo-relative when inside the repo, else the file name only: never an absolute path of the host
const label = (path: string) => {
  const r = relative(ROOT, path);
  return r.startsWith('..') ? basename(path) : r;
};

/** Every pass-rate run in `dir` (titles from its index.json) and the B1 summary. A file in an unknown shape is skipped and logged. */
export const loadModelRuns = async (dir: string, b1Path: string): Promise<ModelRuns> => {
  const names = (await readdir(dir)).sort();
  let titles: Record<string, string> = {};
  if (names.includes('index.json')) {
    try {
      titles = parseRunIndex(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')));
    } catch (error) {
      log.warn('run index could not be parsed; titles fall back to the run fields', { ...errFields(error) });
    }
  }
  const runs: ModelRun[] = [];
  const source: string[] = [];
  for (const f of names.filter((n) => PASS_RATE_RE.test(n))) {
    const id = f.replace(/\.json$/, '');
    try {
      runs.push(parsePassRate(id, JSON.parse(await readFile(join(dir, f), 'utf8')), titles[id]));
      source.push(label(join(dir, f)));
    } catch (error) {
      log.warn('skipping a pass-rate file in an unknown shape', { file: f, ...errFields(error) });
    }
  }
  runs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  let b1: ModelRuns['b1'] = null;
  try {
    b1 = { ...parseB1Summary(JSON.parse(await readFile(b1Path, 'utf8'))), source: label(b1Path) };
    source.push(b1.source);
  } catch (error) {
    log.warn('B1 summary could not be read', { file: label(b1Path), ...errFields(error) });
  }
  return { runs, source, b1 };
};
