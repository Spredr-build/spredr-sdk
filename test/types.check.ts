// Type tests: never run, only compiled by `npm run check`. Each @ts-expect-error must stay an error and every other line
// must compile, so the types a user leans on (kinds end to end, schemas, results) cannot break without the check failing.

import { Agent, Caller, type KindsOf, type StandardSchemaV1 } from '../src/index.ts';

declare const schema: StandardSchemaV1<{ id: string }, { id: string; at: Date }>;

export function typesHold(): void {
  const shop = new Agent()
    .on('reply', (input: { text: string }) => ({ reply: input.text }))
    .on('refund', schema, async (input) => ({ refunded: input.at.getTime() > 0 }));

  const backend = new Caller<KindsOf<typeof shop>>();
  const reply: Promise<{ reply: string }> = backend.result('reply', { text: 'hola' });
  const refunded: Promise<{ refunded: boolean }> = backend.result('refund', { id: 'ord_1' });
  void reply;
  void refunded;

  // @ts-expect-error a kind the agent does not handle
  void backend.ask('cancel', { text: 'x' });
  // @ts-expect-error the input of another kind
  void backend.ask('reply', { id: 'ord_1' });
  // @ts-expect-error a schema's input is what goes in, not what it makes
  void backend.ask('refund', { id: 'ord_1', at: new Date() , extra: 1 });

  // without the agent's kinds, any kind goes, JSON in and out
  const loose = new Caller();
  void loose.ask('anything', { any: ['json', 1, true, null] });
  // @ts-expect-error a function is not JSON
  void loose.ask('anything', () => 1);
  // untyped, the result is free (as fetch's json()): it can be taken apart without a cast
  void (async () => { const { reply } = await loose.result('anything', 'hola'); return reply; });

  // a handler may return what the SDK gives it: an interface is fine, not only plain JSON
  new Agent().on('ask', async (_input, ctx) => ({ answer: await ctx.ask('refund', 'Refund?') }));
}
