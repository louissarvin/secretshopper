import type { InboxItem, State } from './inboxClient.ts';
import type { InvoiceOutcome } from './loop.ts';
import { errMessage } from './log.ts';
import { InferenceBudgetExhausted } from './usage.ts';

export type ItemOutcome = 'processed' | 'retry' | 'given_up' | 'budget';

/** One invoice of index.ts: run the model loop, then advance, retry or give up (AG-03). */
export const runItem = async (o: {
  item: InboxItem;
  state: State;
  process: () => Promise<InvoiceOutcome>;
  advance: (state: State, item: InboxItem, opts?: { ack: boolean }) => Promise<void>;
  saveState: (state: State) => Promise<void>;
  maxAttempts: number;
  log: { info: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void; error: (m: string, f?: Record<string, unknown>) => void };
  fields?: Record<string, unknown>;
}): Promise<ItemOutcome> => {
  const { item, state } = o;
  try {
    const r = await o.process();
    o.log.info('invoice processed', { invoice: item.id, receivedAt: item.receivedAt, ...o.fields, ...r });
    await o.advance(state, item);
    return 'processed';
  } catch (error) {
    // not a failure and not an attempt: the invoice waits, undecided and out of any tick, until the window frees.
    // Declining would refuse genuine invoices; paying without a model decision never happens.
    if (error instanceof InferenceBudgetExhausted) return 'budget';
    const attempts = (state.attempts[item.id] ?? 0) + 1;
    state.attempts[item.id] = attempts;
    o.log.error('invoice failed', { invoice: item.id, attempts, error: errMessage(error) });
    if (attempts >= o.maxAttempts) {
      o.log.warn('leaving invoice unanswered and out of the ack after repeated failures', { invoice: item.id });
      await o.advance(state, item, { ack: false });
      return 'given_up';
    }
    await o.saveState(state);
    return 'retry';
  }
};
