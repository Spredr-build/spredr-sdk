<p align="center">
  <a href="https://spredr.cloud"><img src="https://spredr.cloud/branding/banner/github-social-dark-1280x640.png" alt="spredr: put your backends online" width="720"></a>
</p>

<h1 align="center">@spredr/sdk</h1>

<p align="center">
  <b>AI agents that run as your own services.</b><br>
  They take tasks, ask before they act, remember your customers, learn from your corrections, and sleep when idle.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@spredr/sdk"><img src="https://img.shields.io/npm/v/@spredr/sdk?color=C2410C&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/dependencies-0-14161C" alt="no dependencies">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-14161C" alt="Node 20 or newer">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-agent">The agent</a> ·
  <a href="#your-backend">Your backend</a> ·
  <a href="#you-with-your-token">Your token</a> ·
  <a href="#traces">Traces</a> ·
  <a href="https://spredr.cloud/pricing">Pricing</a>
</p>

---

## Three pieces, one agent

An agent on spredr is a normal service: your code, your repo, deployed like any backend. This package is how the
three parties around it talk to each other.

| You are | You use | You can |
|---|---|---|
| **The agent** | `Agent` | take tasks, ask a person before a risky action, remember, learn, report each step |
| **Your backend** | `Caller` | give the agent tasks, follow them, answer its questions, receive callbacks |
| **You** | `Spredr` | register agents, link backends, schedule work, read memory, approve lessons, set limits |

```text
  your backend ──── task ────▶ spredr ──── task ────▶ your agent
   (Caller)    ◀─ result ───    (ai)   ◀─ result ───   (Agent)
                                  ▲
                                  │  questions, memory, lessons, limits
                                  │
                               you (Spredr)
```

**No shared secrets.** Every request is signed with ed25519, and each side keeps only the other's public key. When you
register an agent or link a backend, spredr writes the keys into that service's variables for you: there is nothing to
copy or paste.

## Quick start

**1. Install the CLI and sign in**

```sh
curl -fsSL https://spredr.cloud/install | sh
spredr login
```

**2. Write the agent**

```sh
npm install @spredr/sdk @anthropic-ai/sdk
```

```ts
// index.ts
import { Agent } from '@spredr/sdk';
import Anthropic from '@anthropic-ai/sdk';

const claude = new Anthropic(); // ANTHROPIC_API_KEY, set with: spredr vars set shop-agent ANTHROPIC_API_KEY=…

new Agent({ description: 'Answers the shop\'s customers', sleepAfterMinutes: 15 })
  .on('reply', async (input, ctx) => {
    const { text } = input as { text: string };
    const message = await ctx.track('model', 'reply', () => claude.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 400,
      system: ['You answer for a small shop. Be brief.', ...ctx.lessons].join('\n'),
      messages: [{ role: 'user', content: text }],
    }), (answer) => ({ model: answer.model, tokensIn: answer.usage.input_tokens, tokensOut: answer.usage.output_tokens }));
    const answer = message.content.find((block) => block.type === 'text');
    return { reply: answer?.type === 'text' ? answer.text : '' };
  })
  .listen(); // PORT, 8080 by default
```

**3. Deploy it and make it an agent**

Push it to a repo, then:

```sh
spredr new you/shop-agent --port 8080   # a service, built from your repo
spredr agents add shop shop-agent       # the service becomes the agent «shop»
```

**4. Give it a task**

```sh
spredr ask shop reply '{"text":"Are you open on Sunday?"}'
```

**5. Call it from your backend**

```ts
import { Spredr } from '@spredr/sdk';

// once, with your token: link your backend's service to the agent
await new Spredr().agent('shop').addCaller('shop-api', { service: 'shop-api' });   // reads SPREDR_TOKEN
```

```ts
// in shop-api: the variables are already there
import { Caller } from '@spredr/sdk';

const shop = Caller.fromEnv();
const task = await shop.run('reply', { text: 'Are you open on Sunday?' });
console.log(task.result); // { reply: '…' }
```

That is the whole loop. Everything below is reference.

## The agent

```ts
import { Agent } from '@spredr/sdk';

new Agent({
  description: 'Answers the shop\'s customers',
  tasks: [{ kind: 'reply', description: 'Answer one message' }],
  actions: [{ name: 'refund', neverAuto: true }],
  sleepAfterMinutes: 15,
  concurrency: 4,
})
  .on('reply', async (input, ctx) => {
    const { customer, text, wantsRefund } = input as { customer: string; text: string; wantsRefund?: boolean };
    const known = await ctx.memory.recall({ scope: `customer:${customer}` });
    if (wantsRefund) {
      const answer = await ctx.ask('refund', `Refund ${customer}?`);
      if (!answer.yes) return { reply: 'We cannot refund this one.' };
    }
    await ctx.memory.remember(`customer:${customer}`, `Asked: ${text}`, { key: 'last' });
    return { reply: await think(text, known, ctx.lessons) };   // think(): your model call
  })
  .listen();
```

Each task kind gets a handler. **What it returns is the task's result, and what it throws is its error.** `ctx` gives
it the rest:

| | |
|---|---|
| `ctx.ask(action, question)` | Asks a person first. The task stops here, and when someone answers it comes back with the answer and the handler runs again **from the top**: write it so running twice is safe. An action marked `neverAuto` asks every time. |
| `ctx.memory` | `remember(scope, text)`, `recall({ scope, q })`, `forget(id)`. A scope is whatever groups facts, such as `customer:ana`. |
| `ctx.lessons` | The lessons you approved. Put them in your prompt. |
| `ctx.trial` | `true` when an old task is replayed to test new lessons: **do nothing real**, just answer. |
| `ctx.track(kind, name, work, usage?)` | Times a step (`model`, `tool`, `memory`, `other`) and reports it. For a model call, read the tokens from its answer. Steps are the task's trace, its cost and its timeline. |
| `ctx.later(kind, input, at)` | A task for later: a reminder, a follow-up. |
| `ctx.progress(data)` | Tells the caller how it is going, and keeps a long task alive. |

**Learning.** The agent reads the verdicts on its tasks with `agent.feedback()` and turns what it sees into a lesson
with `agent.propose(text, why)`. A lesson goes live only when you approve it, and before that it can be tried on old
tasks (`ctx.trial`).

**Sleeping.** An agent that is quiet for `sleepAfterMinutes` is put to sleep and uses no CPU. The next task wakes it, and waits until
it answers.

## Your backend

```ts
import { Caller } from '@spredr/sdk';

const agent = Caller.fromEnv();

const task = await agent.run('reply', { customer: 'ana', text: 'hola' }, { key: messageId, thread: 'customer:ana' });

if (task.status === 'paused') {
  const [question] = await agent.pauses();         // show it in your app
  await agent.answer(question.id, { yes: true });
}

await agent.feedback(task.id, 'bad', { correction: 'Offer two times.' });   // kept for the agent to learn from
```

| | |
|---|---|
| `run(kind, input)` | Asks and waits for the outcome. |
| `ask(kind, input)` | Asks and returns at once. `settle(id)` waits for it later. |
| `key` | Your own id for the task: asking twice with the same key is the same task, never two. |
| `thread` | Tasks with the same thread read as one conversation. |
| `at` | When to start. |
| `list()`, `events(id)`, `steps(id)`, `cancel(id)` | Follow and stop tasks. |
| `pauses()`, `answer(id, answer)` | The questions the agent is waiting on. |
| `feedback(id, 'good' \| 'bad', { correction })` | Your verdict, with what it should have done. |

**Callbacks.** Link the backend with a `callbackUrl` and spredr POSTs `task.done`, `task.failed`, `task.paused` and
`task.canceled` to it. Believe one only when `agent.callback({ method, path, headers, body })` returns it, and give it
the raw body. With `everything: true` the backend receives every task's events, not only its own.

## You, with your token

```ts
import { Spredr } from '@spredr/sdk';

const spredr = new Spredr();   // SPREDR_TOKEN, or new Spredr({ token })
const shop = spredr.agent('shop');

await spredr.register('shop', 'shop-agent');                    // a service becomes an agent
await shop.addCaller('shop-api', { service: 'shop-api' });     // a backend may call it
await shop.schedule('morning', 'digest', '0 8 * * *', { tz: 'America/Bogota' });
await shop.hook('orders', 'new-order');                        // a webhook URL that makes tasks
await shop.setFreedom('refund', 'ask');                        // ask before refunds
await shop.setLimits({ autoPerDay: 200, spendPerDayUsd: 15 });

await shop.summary();          // its last day: tasks, failures, times, tokens, cost
await shop.memory({ scope: 'customer:ana' });
await shop.forget('customer:ana');                              // a customer who asks to be forgotten
await shop.lessons();          // proposed and live lessons; decide(id, 'accept') to approve one
await shop.export();           // every task with its steps
await spredr.inbox();          // what waits for you, across every agent
```

**Limits keep a mistake small.** `autoPerDay` caps the actions it takes alone in a day; past it, it asks again.
`spendPerDayUsd` caps what its model calls cost in a day, read from the steps it reports; past it, new tasks are
refused until tomorrow.

## Traces

Every finished task can go to your OpenTelemetry endpoint as a trace: the task as the root span, each step as a child
with the GenAI attributes (`gen_ai.*`) that Langfuse, Datadog, Honeycomb and Grafana read.

```ts
import { Spredr } from '@spredr/sdk';

await new Spredr().agent('shop').setTraces({
  endpoint: 'https://cloud.langfuse.com/api/public/otel/v1/traces',
  headers: { authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}` },
});
```

The headers are sealed by spredr and never shown back. The task's input and result travel only with
`withContent: true`.

## Variables

spredr writes these into your services when you register an agent or link a backend. You only set `SPREDR_TOKEN`.

| Variable | Read by | What it is |
|---|---|---|
| `SPREDR_AGENT_ID`, `SPREDR_AGENT_KEY` | `Agent` | the agent's id and private key |
| `SPREDR_CALLER_ID`, `SPREDR_CALLER_KEY`, `SPREDR_AGENT` | `Caller.fromEnv()` | the backend's id, its private key, the agent it calls |
| `SPREDR_AI_URL`, `SPREDR_AI_KEY` | `Agent`, `Caller` | where spredr's agents live, and its public key |
| `SPREDR_TOKEN` | `Spredr` | an API token of yours, made in the panel (Account › API tokens) |
| `PORT` | `Agent.listen()` | the port it listens on, 8080 by default |

## Plans

An agent runs as one of your plan's services, so Starter runs up to 3 and Pro up to 10. The plan also sets the tasks a
month, how much each agent remembers and how long finished tasks are kept. Exporting and traces are always included.
See [spredr.cloud/pricing](https://spredr.cloud/pricing).

## Without the SDK

It is plain HTTP and works from any language: signed requests one way, signed callbacks the other. The SDK has no
dependencies; write to us if you need the protocol for another language.

---

<p align="center">
  <a href="https://spredr.cloud"><img src="https://spredr.cloud/branding/logo/spredr-mark-512.png" alt="spredr" width="40"></a><br>
  <sub><a href="https://spredr.cloud">spredr.cloud</a> · © 2026 Candhrly, LLC · <a href="LICENSE">license</a></sub><br>
  <sub>Free to use with spredr. spredr and its logo are trademarks of Candhrly, LLC.</sub>
</p>
