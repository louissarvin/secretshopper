import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import type { ChatClient, ReceiptRef } from '../src/llm.ts';
import { createAgentLoop } from '../src/loop.ts';
import type { ToolResult } from '../src/tools.ts';

// The model is scripted here; this checks the loop's ordering: verify each reply, then act on it.
const ITEM = { id: 'd'.repeat(64), receivedAt: '2026-11-06T00:00:00Z', email: {}, document: {} };

const reply = (id: string, toolCall?: { name: string; args: string }): OpenAI.Chat.ChatCompletion =>
  ({
    id,
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        finish_reason: toolCall ? 'tool_calls' : 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          ...(toolCall ? { tool_calls: [{ id: `call-${id}`, type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }] } : {}),
        },
      },
    ],
  }) as OpenAI.Chat.ChatCompletion;

const scripted = (replies: OpenAI.Chat.ChatCompletion[]): ChatClient => ({
  chat: { completions: { create: (async () => replies.shift()!) as unknown as ChatClient['chat']['completions']['create'] } },
});

const receipt = (id: string): ReceiptRef => ({ id, signature_kind: 'provider_tee', signing_algo: 'ed25519', signer: 'ab'.repeat(32), tcb_status: 'UpToDate' });

describe('agent loop', () => {
  test('every model step is verified and its receipt id is kept with the decision', async () => {
    const verified: string[] = [];
    const tools: string[] = [];
    const loop = createAgentLoop({
      llm: scripted([reply('r1', { name: 'get_vendor', args: '{}' }), reply('r2', { name: 'decline', args: '{}' })]),
      verify: async (id) => (verified.push(id), receipt(id)),
      model: 'm',
      maxSteps: 4,
    });
    const run = async (name: string): Promise<ToolResult> => (tools.push(name), { final: name === 'decline', output: { ok: true } });
    const out = await loop(ITEM, 'Armed', 'Co', run, false);
    expect(verified).toEqual(['r1', 'r2']);
    expect(tools).toEqual(['get_vendor', 'decline']);
    expect(out.receipts.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(out.decided).toBe(true);
  });

  test('a reply whose signature fails verification runs no tool', async () => {
    const tools: string[] = [];
    const loop = createAgentLoop({
      llm: scripted([reply('bad', { name: 'pay', args: '{}' })]),
      verify: async () => {
        throw new Error('signature.invalid');
      },
      model: 'm',
      maxSteps: 2,
    });
    await expect(loop(ITEM, 'Armed', 'Co', async (n) => (tools.push(n), { final: true, output: {} }), false)).rejects.toThrow('signature.invalid');
    expect(tools).toEqual([]);
  });

  test('AG-04: with requireProviderTee a Gateway-signed reply runs no tool', async () => {
    const tools: string[] = [];
    const loop = createAgentLoop({
      llm: scripted([reply('g1', { name: 'pay', args: '{}' })]),
      verify: async (id) => ({ ...receipt(id), signature_kind: 'gateway' }),
      model: 'm',
      maxSteps: 2,
      requireProviderTee: true,
    });
    await expect(loop(ITEM, 'Armed', 'Co', async (n) => (tools.push(n), { final: true, output: {} }), false)).rejects.toThrow('a model TEE signature is required');
    expect(tools).toEqual([]);
  });
});
