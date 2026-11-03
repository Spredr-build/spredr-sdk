# @spredr/sdk

Agents on [spredr](https://spredr.cloud), from three sides, with no dependencies:

- **`Agent`**: the agent itself. It takes tasks, asks before acting, remembers, and learns.
- **`Caller`**: your backend, linked to one agent. It asks for tasks, follows them and answers questions.
- **`Spredr`**: you, with your spredr token. You manage agents, the backends that may call them, schedules, memory and lessons.

Every request is signed with ed25519. Each side keeps only the other's public key, so no secret is shared. On spredr,
the keys are written into your services' variables for you.

```sh
npm install @spredr/sdk
```

## An agent

```ts
import { Agent } from '@spredr/sdk';

new Agent({ actions: [{ name: 'refund', neverAuto: true }], sleepAfterMinutes: 15 })
  .on('reply', async (input, ctx) => {
    const known = await ctx.memory.recall({ scope: `customer:${input.customer}` });
    if (input.wantsRefund) {
      const answer = await ctx.ask('refund', `Refund ${input.customer}?`);
      if (!answer.yes) return { reply: 'We cannot refund this one.' };
    }
    await ctx.memory.remember(`customer:${input.customer}`, `Asked: ${input.text}`, { key: 'last' });
    return { reply: await think(input.text, known, ctx.lessons) };
  })
  .listen();
```

- **Results.** Whatever a handler returns is the task's result, and whatever it throws is its error.
- **Asking first.** `ctx.ask()` stops the task until someone answers. The task then comes back with the answer and the
  handler runs again from the top, so write it to be run twice.
- **Lessons.** `ctx.lessons` are the live lessons; put them in your prompt.
- **Trials.** `ctx.trial` means a trial replaying an old task with new lessons: do nothing real.
- **Steps.** `ctx.track('tool', 'orders.find(1042)', () => api.find(1042))` times a step and reports it; for a model
  call, pass a reader of its usage to count tokens and cost. Steps are the task's trace, its cost and its tools' use.

## Your backend

```ts
import { Caller } from '@spredr/sdk';

const agent = Caller.fromEnv();   // SPREDR_CALLER_ID, SPREDR_CALLER_KEY, SPREDR_AGENT, SPREDR_AI_URL, SPREDR_AI_KEY

const task = await agent.run('reply', { customer: 'ana', text: 'hola' }, { key: messageId, thread: 'customer:ana' });
if (task.status === 'paused') { /* show the question in your app, then: */ }
const [question] = await agent.pauses();
await agent.answer(question.id, { yes: true });
await agent.feedback(task.id, 'bad', { correction: 'Offer two times.' });
```

- **Waiting.** `run()` waits for the outcome. `ask()` returns at once, and `settle()` waits for a task already asked.
- **Callbacks.** With a `callbackUrl`, ai POSTs `task.done`, `task.failed`, `task.paused` and `task.canceled` to it.
  Believe one only if `agent.callback({ method, path, headers, body })` returns it. Give it the raw body.

## You, with your token

```ts
import { Spredr } from '@spredr/sdk';

const spredr = new Spredr({ token: process.env.SPREDR_TOKEN });
await spredr.register('shop', 'shop-agent');                 // a spredr service becomes an agent
await spredr.agent('shop').addCaller('shop-api', { service: 'shop-api' });
await spredr.agent('shop').schedule('morning', 'digest', '0 8 * * *', { tz: 'America/Bogota' });
await spredr.agent('shop').forget('customer:ana');           // a customer who asks to be forgotten
await spredr.agent('shop').summary();                        // its last day: tasks, failures, times, tokens, cost
await spredr.agent('shop').setLimits({ autoPerDay: 200, spendPerDayUsd: 15 });
await spredr.inbox();                                        // what waits for you across every agent
```

## Without the SDK

The protocol is plain HTTP and works from any language. See `ai/README.md` in spredr for the contract, and
`lab/agents/echo/agent.mjs` for a whole agent in one file.
