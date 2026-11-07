import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import type { ChatClient } from '../src/llm.ts';
import { createAgentLoop } from '../src/loop.ts';
import { POLICIES, POLICY, REALISTIC_POLICY, systemPrompt } from '../src/policy.ts';

const ITEM = { id: 'e'.repeat(64), receivedAt: '2026-11-12T00:00:00Z', email: {}, document: {} };

// Captures the system prompt the loop sends, then ends the conversation with no tool call.
const systemOf = async (policy?: 'strict' | 'realistic'): Promise<string> => {
  let sent = '';
  const llm: ChatClient = {
    chat: {
      completions: {
        create: (async (body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming) => {
          sent = String(body.messages[0].content);
          return { id: 'r1', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done', refusal: null } }] };
        }) as unknown as ChatClient['chat']['completions']['create'],
      },
    },
  };
  const verify = async (id: string) => ({ id, signature_kind: 'provider_tee' as const, signing_algo: 'ed25519', signer: 'ab'.repeat(32), tcb_status: 'UpToDate' });
  const loop = createAgentLoop({ llm, verify, model: 'm', maxSteps: 1, ...(policy ? { policy } : {}) });
  await loop(ITEM, 'Armed', 'Acme Pte Ltd', async () => ({ final: false, output: {} }), false);
  return sent;
};

describe('AP policy selection', () => {
  test('the default is the strict policy, unchanged', async () => {
    expect(systemPrompt('Acme Pte Ltd', 'pay')).toBe(systemPrompt('Acme Pte Ltd', 'pay', 'strict'));
    expect(POLICIES.strict).toBe(POLICY);
    expect(POLICY).toContain('Never pay a payee that is not on that list');
    const sent = await systemOf();
    expect(sent).toBe(POLICY.replace('{COMPANY}', 'Acme Pte Ltd').replace('{FINAL_TOOL}', 'pay'));
  });

  test('the realistic policy is used only when asked for', async () => {
    const sent = await systemOf('realistic');
    expect(sent).toBe(REALISTIC_POLICY.replace('{COMPANY}', 'Acme Pte Ltd').replace('{FINAL_TOOL}', 'pay'));
    expect(sent).toContain('may be paid when the invoice is consistent');
    expect(sent).not.toContain('Never pay a payee that is not on that list');
  });

  test('both policies fill every placeholder for both final tools', () => {
    for (const p of ['strict', 'realistic'] as const) {
      for (const tool of ['pay', 'propose'] as const) {
        const s = systemPrompt('Acme Pte Ltd', tool, p);
        expect(s).not.toMatch(/\{[A-Z_]+\}/);
        expect(s).toContain(`${tool} or decline`);
      }
    }
  });
});
