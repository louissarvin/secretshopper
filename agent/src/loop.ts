import type OpenAI from 'openai';
import type { ChatClient, ReceiptRef, VerifyReceipt } from './llm.ts';
import { log } from './log.ts';
import { systemPrompt, type PolicyName } from './policy.ts';
import { toolsFor, type Mode, type ToolResult } from './tools.ts';
import type { Meter } from './usage.ts';

export type InboxItem = { id: string; receivedAt: string; email: unknown; document: unknown };
export type RunTool = (name: string, rawArgs: string, ctx: { invoiceId: string; mode: Mode; vendorId?: string }) => Promise<ToolResult>;

export interface InvoiceOutcome {
  decided: boolean;
  tool: string | null;
  steps: number;
  calls: { tool: string; args: string; final: boolean; error?: string }[];
  receipts: ReceiptRef[]; // one verified NEAR AI receipt per model step
  output?: unknown;
}

/** One conversation per invoice, no memory across invoices. Never auto-declines. No tool runs on an unverified reply. */
// requireProviderTee: refuse Gateway-signed receipts, which do not prove the model ran in a TEE (AG-04)
// policy: the system prompt's AP policy, strict unless set (the realistic one is for measurements only)
// meter: checks the inference budget before each call (throws InferenceBudgetExhausted) and books its usage
export const createAgentLoop = (o: { llm: ChatClient; verify: VerifyReceipt; model: string; maxSteps: number; requireProviderTee?: boolean; policy?: PolicyName; meter?: Pick<Meter, 'check' | 'record'> }) =>
  async (item: InboxItem, mode: Mode, company: string, runTool: RunTool, intentsEnabled: boolean): Promise<InvoiceOutcome> => {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt(company, mode === 'Armed' ? 'pay' : 'propose', o.policy) },
      { role: 'user', content: JSON.stringify({ invoice_id: item.id, received_at: item.receivedAt, email: item.email, invoice: item.document }) },
    ];
    const tools = toolsFor(mode, intentsEnabled);
    const calls: InvoiceOutcome['calls'] = [];
    const receipts: ReceiptRef[] = [];
    for (let step = 0; step < o.maxSteps; step++) {
      o.meter?.check();
      const res = await o.llm.chat.completions.create({ model: o.model, messages, tools, tool_choice: 'auto', temperature: 0 });
      // booked before verification: the call is paid for whether or not its signature checks out
      await o.meter?.record({ model: o.model, invoice: item.id, step, id: res.id, usage: res.usage });
      // a failed signature check throws: the invoice is retried, nothing from this reply is executed
      const receipt = await o.verify(res.id);
      if (o.requireProviderTee && receipt.signature_kind !== 'provider_tee') throw new Error(`receipt ${receipt.id} is ${receipt.signature_kind}-signed; a model TEE signature is required`);
      receipts.push(receipt);
      log.info('model step verified', { invoice: item.id, step, receipt_id: receipt.id, signature_kind: receipt.signature_kind, signer: receipt.signer, tcb_status: receipt.tcb_status });
      const msg = res.choices[0]?.message;
      if (!msg) break;
      messages.push(msg);
      if (!msg.tool_calls?.length) break;
      for (const call of msg.tool_calls) {
        if (call.type !== 'function') {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'only function tools are supported' }) });
          continue;
        }
        const vendorId = (item.document as { vendor_id?: unknown } | null)?.vendor_id;
        const out = await runTool(call.function.name, call.function.arguments, { invoiceId: item.id, mode, ...(typeof vendorId === 'string' ? { vendorId } : {}) });
        const error = (out.output as { error?: string } | null)?.error;
        calls.push({ tool: call.function.name, args: call.function.arguments, final: out.final, ...(error ? { error } : {}) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.output) });
        if (out.final) return { decided: true, tool: call.function.name, steps: step + 1, calls, receipts, output: out.output };
      }
    }
    // no decision is recorded as Unanswered on chain
    return { decided: false, tool: null, steps: o.maxSteps, calls, receipts };
  };
