// MCP server config: the native agent's chain and inbox settings, its own state file, no NEAR AI key.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { chainConfig, int } from '../env.ts';
import type { PreflightMode } from '../tools.ts';

export const CONCURRENT_WINDOW_MS = 120_000;
// The native agent runs from agent/ (bun run start), so its relative paths mean agent/. MCP clients start this
// server from any cwd; relative paths are read against agent/ too so both name the same files (NF-05).
export const AGENT_DIR = resolve(import.meta.dir, '..', '..');
export const agentPath = (p: string): string => (isAbsolute(p) ? p : join(AGENT_DIR, p));

export const mcpConfig = () => {
  const c = chainConfig();
  const MCP_STATE_PATH = agentPath(process.env.MCP_STATE_PATH || './agent-state-mcp.json');
  const AGENT_STATE_FILE = agentPath(process.env.AGENT_STATE_FILE || './state.json');
  // two processes on one cursor would each decide and ack items the other saw
  if (MCP_STATE_PATH === AGENT_STATE_FILE) throw new Error('MCP_STATE_PATH must differ from AGENT_STATE_FILE');
  return {
    ...c,
    MCP_STATE_PATH,
    AGENT_STATE_FILE,
    MCP_DECISION_TIMEOUT_S: int('MCP_DECISION_TIMEOUT_S', 1800, 60, 86_400),
    MCP_MAX_TOOL_CALLS_PER_INVOICE: int('MCP_MAX_TOOL_CALLS_PER_INVOICE', 20, 2, 1000),
    // whole result incl. policy; under Claude Code's 50,000-character inline limit and 25k-token output cap (NF-01)
    MCP_MAX_RESULT_BYTES: int('MCP_MAX_RESULT_BYTES', 45_000, 4_000, 1_000_000),
    MCP_ALLOW_CONCURRENT: process.env.MCP_ALLOW_CONCURRENT === '1',
    MCP_PREFLIGHT: preflightMode(process.env.MCP_PREFLIGHT),
  };
};

export const preflightMode = (v: string | undefined): PreflightMode => {
  if (v === undefined || v === '' || v === 'enforce') return 'enforce';
  if (v === 'advisory') return 'advisory';
  throw new Error('MCP_PREFLIGHT must be enforce or advisory');
};

/**
 * Best effort: refuses to start while the native agent's state file was written in the last 120 s, a sign that
 * index.ts is running with this key. An idle native agent can go longer without a write, so this is not a lock.
 */
export const assertNoNativeAgent = (stateFile: string, nowMs: number, allow: boolean): void => {
  if (allow) return;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(stateFile).mtimeMs;
  } catch {
    return; // no native state file here
  }
  if (nowMs - mtimeMs < CONCURRENT_WINDOW_MS) {
    throw new Error(`${stateFile} was written ${Math.round((nowMs - mtimeMs) / 1000)} s ago: the native agent looks active. Stop it, or set MCP_ALLOW_CONCURRENT=1`);
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by another user
  }
};

/** Exclusive `<state>.lock` holding this pid, so two MCP servers never share one cursor (NF-05). Returns the release. */
export const acquireStateLock = (statePath: string, pid = process.pid): (() => void) => {
  const lock = `${statePath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lock, 'utf8').trim() === String(pid)) unlinkSync(lock);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = Number(readFileSync(lock, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw new Error(`${lock} is held by pid ${holder}: another MCP server uses this state. Set a different MCP_STATE_PATH`);
      unlinkSync(lock); // stale: its process is gone
    }
  }
  throw new Error(`could not take ${lock}`);
};
