<p align="center">
  <a href="https://spredr.cloud">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://spredr.cloud/branding/banner/github-social-1280x640.png">
      <img src="https://spredr.cloud/branding/banner/github-social-dark-1280x640.png" alt="spredr: put your backends online" width="720">
    </picture>
  </a>
</p>

<h1 align="center">@spredr/sdk</h1>

<p align="center">
  <b>AI agents that run as your own services.</b><br>
  They take tasks, ask before they act, remember your customers, learn from your corrections, and sleep when idle.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@spredr/sdk"><img src="https://img.shields.io/npm/v/@spredr/sdk?color=C2410C&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/dependencies-0-14161C" alt="no dependencies">
  <img src="https://img.shields.io/badge/node-%E2%89%A522.12-14161C" alt="Node 22.12 or newer">
  <a href="https://unpkg.com/@spredr/sdk/LICENSE"><img src="https://img.shields.io/badge/license-spredr%20SDK%20License-14161C" alt="License: spredr SDK License"></a>
</p>

<p align="center">
  <a href="#what-it-is">What it is</a> ·
  <a href="#what-you-need">What you need</a> ·
  <a href="#why-spredr-for-your-agents">Why</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-agent">The agent</a> ·
  <a href="#your-backend">Your backend</a> ·
  <a href="#one-agent-many-users-at-once">Many users</a> ·
  <a href="#you-with-your-token">Your token</a> ·
  <a href="#traces">Traces</a> ·
  <a href="#license">License</a> ·
  <a href="https://spredr.cloud/pricing">Pricing</a>
</p>

---

## What it is

`@spredr/sdk` is how you build an AI agent as an ordinary Node service and run it on [spredr](https://spredr.cloud).
Your code says what the agent does, and calls the model you choose (Claude, OpenAI, Gemini or your own) with your own
key. spredr runs it like any other backend and adds what an agent needs to be trusted with real work:

- it hands the agent **tasks**, with every user taking turns so a busy one never holds the others back, and keeps a
  journal so a task that comes back never does a step twice;
- it **holds a risky action** (a refund, an email, a booking) until a person says yes;
- it keeps a **memory per customer**, and turns your corrections into lessons;
- it shows **every step**, with its tokens and cost.

The same package is used from three places: inside the agent (`Agent`), in your backend to give it tasks (`Caller`),
and by you to manage it (`Spredr`). [Three pieces, one agent](#three-pieces-one-agent) shows how they fit.

## What you need

- **A spredr account** ([spredr.cloud](https://spredr.cloud)) and its CLI: `curl -fsSL https://spredr.cloud/install | sh`,
  then `spredr login`.
- **Node 22.12 or newer.** The SDK has no dependencies of its own.
- **A Git repository** (GitHub or GitLab) with the agent's code: spredr builds it and runs it as a service.
- **A key for the model you use**, kept as a variable of that service (`spredr vars set shop-agent ANTHROPIC_API_KEY=…`).
  spredr never calls the model for you and never sits between your agent and it.
- **Optionally, a backend on spredr** that gives the agent its tasks with `Caller`.

Nothing to copy between them: when you register the agent and link a backend, spredr writes each side's keys into its
service's variables. The [Quick start](#quick-start) takes you from nothing to a first answer in five steps.

## Why spredr for your agents

- **Nothing happens twice.** When a task comes back (after a question, or after a crash), every answer and every
  step it already took gives back what it gave: the model is not paid twice, a customer is not charged twice. No
  «write it to run twice» rule.
- **It asks before it acts.** A risky action waits for a person; approved often enough, it is offered to run alone,
  and an undo takes that back. `autoPerDay` and `spendPerDayUsd` keep a mistake small.
- **It remembers, and it learns.** Memory by customer (and forgetting one on request); your corrections become
  lessons, tried on past tasks before they go live.
- **One agent, thousands of users at once.** Each task says whom it works for (a person, an account, a team, a
  business), and spredr keeps each one apart: its turn in the line, its memory, what it lets the agent do alone, its
  own rules and its caps. One busy user never holds the others back; measured with 301 of them and 1,900 tasks at once.
- **Any model, your key.** Claude, OpenAI, Gemini or a model of your own, called by your code with your key: spredr
  never sits between your agent and its model. `ctx.model()` reads the tokens of Claude, OpenAI and the AI SDK.
- **Light.** An agent takes about 25 MB idle and 36 MB working, measured with a real Claude agent; an agent asleep
  uses no CPU, and spredr adds about 10 ms of its own CPU per task.
- **Yours to watch and to take.** Each task is a trace with its steps, tokens and cost, sent to your
  OpenTelemetry tools (Langfuse, Datadog, Honeycomb); every task exports as NDJSON.
- **Built to be trusted.** Every request signed, no shared secrets, no dependencies, typed end to end, and tested:
  70 tests over 98% of the code, plus the SDK against spredr's real agents service on every change there.

Agents run as your plan's services, with their tasks included: see [pricing](https://spredr.cloud/pricing).

## Three pieces, one agent

An agent on spredr is a normal service: your code, your repo, deployed like any backend. This package is how the
three parties around it talk to each other.

| You are | You use | You can |
|---|---|---|
| **The agent** | `Agent` | take tasks, ask a person before a risky action, remember, learn, report each step |
| **Your backend** | `Caller` | give the agent tasks, follow them, answer its questions, receive callbacks |
| **You** | `Spredr` | register agents, link backends, schedule work, read memory, approve lessons, set limits |

<p align="center">
  <img src="https://spredr.cloud/branding/sdk/flow.webp" width="760" alt="Your backend (Caller) sends a task to spredr (ai), which hands it to your agent (Agent); the result comes back the same way. You (Spredr, with your token) answer questions and manage memory, lessons and limits. Every request is signed with ed25519, with no shared secrets.">
</p>

**Requirements.** Node 22.12 or newer, and nothing else: the SDK has no dependencies. It is written in TypeScript and
ships its types.

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

The example uses Claude; any provider works the same way, because your code calls the model, not spredr (see
[Any model](#any-model) right after it).

```sh
npm install @spredr/sdk @anthropic-ai/sdk
```

```ts
// index.ts
import { Agent } from '@spredr/sdk';
import Anthropic from '@anthropic-ai/sdk';

// ANTHROPIC_API_KEY, set with: spredr vars set shop-agent ANTHROPIC_API_KEY=…
const claude = new Anthropic();

export const shop = new Agent({ description: 'Answers the shop\'s customers', sleepAfterMinutes: 15 })
  .on('reply', async ({ text }: { text: string }, ctx) => {
    // timed, model and tokens reported for you
    const message = await ctx.model(() => claude.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 400,
      system: ['You answer for a small shop. Be brief.', ...ctx.lessons].join('\n'),
      messages: [{ role: 'user', content: text }],
    }));
    const answer = message.content.find((block) => block.type === 'text');
    return { reply: answer?.type === 'text' ? answer.text : '' };
  });

// PORT, 8080 by default
shop.listen();
```

<a id="any-model"></a>**Any model.** Wrap the call in `ctx.model()` and it reads the model and the tokens on its own
for Anthropic, OpenAI (Chat Completions and Responses) and the Vercel AI SDK, which reaches Google, Mistral and the
rest. For anything else, `ctx.track()` takes the numbers from you:

```ts
// OpenAI
const completion = await ctx.model(() => openai.chat.completions.create({ model: 'gpt-4.1-mini', messages }));

// the Vercel AI SDK: Gemini here, any provider it supports
const { text } = await ctx.model(() => generateText({ model: google('gemini-2.5-flash'), prompt: question }));

// your own model, or a client whose answer spredr cannot read: you say what it used
const out = await ctx.track('model', 'my-model', () => myModel.run(question), (result) => ({ model: 'my-model', tokensIn: result.inputTokens, tokensOut: result.outputTokens }));
```

<a id="costs"></a>**What it costs.** Each model call shows its cost in the panel, beside the task that made it. `ctx.model()`
also reads the tokens served from the model's prompt cache and the ones written to it, so each part is priced at its
own rate: input billed in full, cache writes, cache reads and output. When your code sends no `costUsd`, spredr prices
the tokens at the model's list price, the way agent observability tools price a trace, and marks the figure as an
estimate. Your own `costUsd` always wins: send it when you pay a different price (a cloud's rate, a discount, a batch).
A model spredr has no price for shows «no price» rather than $0, until you send its cost. The spend limit
(`spendPerDayUsd`) counts estimates too, so it holds for an agent that never says what it spent.

<a id="slow-and-costly"></a>**Slow and costly.** In the panel, a task past what 95 % of its agent's tasks took in the last
day is marked slow, and one past what 95 % cost is marked costly: the 95th percentile, the usual line for an outlier.
It compares an agent with itself, since a support agent and a code reviewer cost very different things. The marks
appear once the agent has 20 finished tasks in that day; with fewer there is nothing to compare against.

**3. Deploy it and make it an agent**

Push it to a repo, then:

```sh
# a service, built from your repo
spredr new you/shop-agent --port 8080
# the service becomes the agent «shop»
spredr agents add shop shop-agent
```

**4. Give it a task**

```sh
spredr ask shop reply '{"text":"Are you open on Sunday?"}'
```

**5. Call it from your backend**

```ts
import { Spredr } from '@spredr/sdk';

// once, with your token: link your backend's service to the agent
// reads SPREDR_TOKEN
await new Spredr().agent('shop').addCaller('shop-api', { service: 'shop-api' });
```

```ts
// in shop-api: the variables are already there
import { Caller } from '@spredr/sdk';

const { reply } = await new Caller().result('reply', { text: 'Are you open on Sunday?' });
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
  .on('reply', async ({ customer, text, wantsRefund }: { customer: string; text: string; wantsRefund?: boolean }, ctx) => {
    const known = await ctx.memory.recall({ scope: `customer:${customer}` });
    if (wantsRefund) {
      const answer = await ctx.ask('refund', `Refund ${customer}?`);
      if (!answer.yes) return { reply: 'We cannot refund this one.' };
    }
    await ctx.memory.remember(`customer:${customer}`, `Asked: ${text}`, { key: 'last' });
    // think(): your model call
    return { reply: await think(text, known, ctx.lessons) };
  })
  .listen();
```

Each task kind gets a handler. **What it returns is the task's result, and what it throws is its error.** To check
the input before the handler runs, give `on()` a schema: zod, valibot, arktype or any
[Standard Schema](https://standardschema.dev). A task whose input does not match fails, saying where.

```ts
import { z } from 'zod';

agent.on('reply', z.object({ text: z.string().min(1) }), async ({ text }, ctx) => ({ reply: text }));
```

The options, besides the manifest (`description`, `tasks`, `actions`, `tools`, `sleepAfterMinutes`, `concurrency`,
`timeoutSeconds`, `judge`) and the shared ones under [Errors and retries](#errors-and-retries):

| Option | Default | |
|---|---|---|
| `shutdownGraceMs` | 25 000 | on a stop, how long running tasks may finish |
| `log` | the console | where its lines go; `false` says nothing |
| `tagLogs` | `true` | what a task prints with `console` starts with its id; `false` leaves console alone |
| `id`, `key`, `ai`, `aiKey` | its variables | written by spredr when it registers the agent |

`ctx` gives the handler the rest:

| | |
|---|---|
| `ctx.ask(action, question)` | Asks a person first, and stops the task until someone answers. An action marked `neverAuto` asks every time. |
| `ctx.files`, `ctx.file(name)` | The files its session holds (what the backend left with `attach`), and one of them as its bytes and type. spredr only delivers them: how your code reads a CSV, a JSON or a PDF is yours. |
| `ctx.memory` | `remember(scope, text)`, `recall({ scope, q })`, `forget(id)`. A scope is whatever groups facts, such as `customer:ana`. `remember` gives back `null` when the fact was not kept (the agent's memory is full, or its tenant's share): the task goes on, and why is in its logs. |
| `ctx.lessons` | The lessons you approved. Put them in your prompt. |
| `ctx.trial` | `true` when an old task is replayed to test new lessons: **do nothing real**, just answer. |
| `ctx.model(() => call)` | A model call, timed and reported with its model and tokens, read from the answer of Claude, OpenAI or the AI SDK. |
| `ctx.track(kind, name, work, usage?)` | Times any other step (`tool`, `memory`, `other`) and reports it: a charge, an email, a call to your API. Steps are the task's trace, its cost and its timeline. |
| `ctx.later(kind, input, at)` | A task for later: a reminder, a follow-up, for the same tenant and thread. |
| `ctx.delegate(agent, kind, input?, { title?, key? })` | Hands a part of this task to another of your agents and waits for its result (a `PartError` when it failed or was canceled). Several at once with `Promise.all`. You allow it in that agent's settings (whom it may ask, how many at once, how long a chain may grow); the panel draws the chain. |
| `ctx.tenant`, `ctx.thread` | Whom this task works for (a user, an account, a team, a business; `""` when no one in particular) and its conversation. |
| `ctx.progress(data)` | Tells the caller how it is going, and keeps a long task alive. |
| `ctx.show(block)` | Shows a block in the task's page in spredr's panel: an answer with its sources (`answer`), findings (`findings`), an image with what was read in it (`image`), a batch of images (`vision`), a record (`record`), a table (`table`) or a voice recording (`audio`). A type of your own names `as`, the base type to draw it with. Media by reference; up to 256 KB each. |
| `ctx.stream(text)` | The next piece of its answer, for a caller watching live (`live()` or `stream(id)`). Sent in order, a few at a time, and the last pieces before its result. A view: the result is what stays. |

**Nothing happens twice.** When a task comes back (after a question, or given again after a crash), its handler runs
from the top, but everything it already did through `ctx` gives back what it gave the first time instead of happening
again: each answered question, each `ctx.model`, `ctx.track`, `ctx.memory.remember`, `ctx.later` and `ctx.delegate` (the same part, not a new one). The model is not
paid twice and a customer is not charged twice. So put side effects in `ctx.track`; only code outside `ctx` runs again.
If the handler takes another way than before (another question, another step), it runs for real from there on. What a
step gives back comes back as JSON (a `Date` comes back as its text), up to 256 KB; a bigger one simply runs again.

**Showing what it did.** `ctx.show(block)` draws a block in the task's page in the panel, in the order they were
shown, and the panel's list says how many each task showed. It rides on the task's progress, so it costs no extra call
to set up:

```ts
await ctx.show({ type: 'record', title: `Order ${order.id}`, record: order });
await ctx.show({ type: 'table', title: 'Sales', columns: [{ key: 'region' }, { key: 'revenue', kind: 'money' }], rows });
// a type of your own, drawn as a table
await ctx.show({ type: 'x-heatmap', as: 'table', title: 'Visits by hour', columns: [{ key: 'hour' }, { key: 'visits', kind: 'num' }], rows: visits });
```

**Learning.** The agent reads the verdicts on its tasks with `agent.feedback()` and turns what it sees into a lesson
with `agent.propose(text, why)`. A lesson goes live only when you approve it, and before that it can be tried on old
tasks (`ctx.trial`).

**Sleeping.** An agent that is quiet for `sleepAfterMinutes` is put to sleep and uses no CPU. The next task wakes it, and waits until
it answers.

**Stopping.** On a deploy or a stop, the agent takes no new task and lets the running ones finish, up to
`shutdownGraceMs` (25 s); `/health` answers 503 meanwhile. A task still running then is given again by spredr. To stop
it yourself, `await agent.close()`.

**Inside your own server.** An agent can live in a server you already run (Fastify, Express, Hono) instead of
`listen()`: route its path to `handle()` with the raw body, since the signature is over those bytes, and send back what
it returns. `start()` says hello; your server's shutdown calls `close()`.

```ts
// with the body kept raw for this route
app.post(shop.path, async (request, reply) => {
  const answer = await shop.handle({ method: 'POST', path: request.url, headers: request.headers, body: request.rawBody });
  return reply.code(answer.status).headers(answer.headers).send(answer.body);
});
await shop.start();
```

### Its logs, task by task

What a task prints with `console` starts with its id, however deep in your code (`[tsk_7f3a…] looking up the
catalog`), and the agent writes one line when each task ends (`tsk_7f3a… reply done in 4.6 s`, or why it failed). So
searching the deployment's logs for a task's id, as the panel's «Ver sus registros» does, finds what it did. A logger
that writes on its own adds the id with `currentTask()`:

```ts
import pino from 'pino';
import { currentTask } from '@spredr/sdk';

// {"task":"tsk_7f3a…","msg":"…"}
const log = pino({ mixin: () => ({ task: currentTask() ?? undefined }) });
```

## Your backend

```ts
import { Caller } from '@spredr/sdk';

// reads the variables spredr wrote into this service
const agent = new Caller();

// title: what the owner reads in the panel for this task («Refund for order 1042»); optional, one line
const task = await agent.run('reply', { customer: 'ana', text: 'hola' }, { key: messageId, thread: 'customer:ana', title: 'Pregunta de Ana' });

if (task.status === 'paused') {
  // show it in your app
  const [question] = await agent.pauses();
  await agent.answer(question.id, { yes: true });
}

// kept for the agent to learn from
await agent.feedback(task.id, 'bad', { correction: 'Offer two times.' });
```

| | |
|---|---|
| `result(kind, input)` | Asks, waits, and gives back the result. A task that fails, is canceled or waits for an answer throws a `TaskError` carrying it. |
| `run(kind, input)` | Asks and waits for the outcome, whatever it is. |
| `ask(kind, input)` | Asks and returns at once. `settle(id)` waits for it later. |
| `key` | Your own id for the task: asking twice with the same key is the same task, never two. |
| `thread` | Tasks with the same thread read as one conversation. |
| `at` | When to start. |
| `list()`, `events(id)`, `steps(id)`, `cancel(id)` | Follow and stop tasks. |
| `pauses()`, `answer(id, answer)` | The questions the agent is waiting on. |
| `feedback(id, 'good' \| 'bad', { correction })` | Your verdict, with what it should have done. |
| `live(kind, input)`, `stream(id)` | The task as it happens: each piece of its live answer (`{ type: 'delta', text }`), its other events, and last `{ type: 'end', task }`. A stream that closes early is opened again after what was seen. |
| `attach(thread, name, data, { type })`, `files(thread)`, `detach(thread, name)` | Leaves a file in a session for the agent to read in its tasks (a price list, a catalogue, a document): sent once, every task of that thread lists it. The same name again replaces it. Up to 10 MB each; they go with the agent's record's days. |

**Types, end to end.** Give the backend your agent's type and TypeScript checks each kind's name, input and result:

```ts
import type { shop } from '../shop-agent/index.ts';
import { Caller, type KindsOf } from '@spredr/sdk';

const agent = new Caller<KindsOf<typeof shop>>();
// reply: string
const { reply } = await agent.result('reply', { text: 'hola' });
```

**What the agent needs to know.** Give it in the task (`input`, up to 256 KB), as an address its code opens, or as a
session's file when it is bigger or the same for many tasks:

```ts
const shop = agent.for('shop_a');
await shop.attach('chat:ana', 'precios.csv', csv, { type: 'text/csv' });
// the agent reads it with ctx.file('precios.csv')
await shop.result('reply', { text: 'hola' }, { thread: 'chat:ana' });
```

**Callbacks.** Link the backend with a `callbackUrl` and spredr POSTs `task.done`, `task.failed`, `task.paused` and
`task.canceled` to it. Believe one only when `agent.callback({ method, path, headers, body })` returns it, and give it
the raw body. With `everything: true` the backend receives every task's events, not only its own.

## One agent, many users at once

Most agents serve many people at once: an assistant with thousands of users, a support agent for many accounts, a
booking agent for many businesses. Each task can say whom it works for, its **tenant**: whatever your app calls one of
them (a user id, an account, a team, a business). Open a session for one with `for(tenant)`:

```ts
// agent is your Caller
const user = agent.for('user_42');

const { reply } = await user.result('reply', { text: 'remind me to call mom on Friday' }, { thread: 'chat_9' });
```

spredr keeps each tenant apart, with nothing for your agent to remember:

| | |
|---|---|
| **Its turn** | The line goes in turns between tenants: one with a thousand tasks waiting never holds the others back. |
| **Its memory** | `ctx.memory` in a task reaches that tenant's facts alone, whatever the model is talked into. All tenants share the agent's room; `setLimits({ facts })` caps one's share. |
| **Its freedom** | `user.setFreedom('send_email', 'auto')` lets the agent act alone for this tenant, never for another. |
| **Its rules** | `user.teach('Call me Ana, never by my surname')` reaches this tenant's tasks from that moment on, and no other's. |
| **Its caps** | `user.setLimits({ spendPerDayUsd: 0.5, autoPerDay: 20 })`: past them it waits for tomorrow, and the rest go on. |
| **Its questions** | `user.pauses()`, and every `task.paused` callback names the tenant, so it reaches the right person. |
| **What it used** | `user.usage()`: tasks, cost and tokens, today and this month, to bill or limit each one for what it used. |
| **Forgetting it** | `user.forget()` erases its tasks, memory, questions, freedom, rules and caps. The others stay. |

In the agent, `ctx.tenant` says whom the task works for. With your token, `spredr.agent('assistant').tenants()` lists
them with what each used, and `setTenantLimits()` caps every tenant without caps of its own. A task with no tenant is
the agent's own work, as before.

## You, with your token

```ts
import { Spredr } from '@spredr/sdk';

// SPREDR_TOKEN, or new Spredr({ token })
const spredr = new Spredr();
const shop = spredr.agent('shop');

// a service becomes an agent
await spredr.register('shop', 'shop-agent');
// a backend may call it
await shop.addCaller('shop-api', { service: 'shop-api' });
// a task every morning at 8, Bogotá time
await shop.schedule('morning', 'digest', '0 8 * * *', { tz: 'America/Bogota' });
// a webhook URL that makes tasks: each POST to it is a «new-order» task whose input is { body, headers }, the JSON
// posted and its content-type, user-agent, x-… and stripe-signature headers (to check a provider's signature)
await shop.hook('orders', 'new-order');
// agent.on('new-order', async ({ body, headers }, ctx) => { … body.order … })
// ask before refunds
await shop.setFreedom('refund', 'ask');
// at most 200 actions alone and 15 USD a day
await shop.setLimits({ autoPerDay: 200, spendPerDayUsd: 15 });

// its last day: tasks, failures, times, tokens, cost
await shop.summary();
// what it remembers of one customer
await shop.memory({ scope: 'customer:ana' });
// a customer who asks to be forgotten
await shop.forget('customer:ana');
// proposed and live lessons; decide(id, 'accept') to approve one
await shop.lessons();
// every task with its steps; or only some: since, until, status and kind
await shop.export();
await shop.export({ since: '2026-11-01', status: ['failed'], kind: ['refund'] });
// how many that would be, before reading it
await shop.exportCount({ status: ['failed'] });
// what of each task you keep seeing: the customer covered, the messages as fingerprints
await shop.setLimits({ data: { keep: 'rules', auto: true, rules: [{ path: 'input.customer', action: 'hide' }, { path: 'input.messages[].text', action: 'hash' }] } });
// what waits for you, across every agent
await spredr.inbox();
```

**Limits keep a mistake small.** `autoPerDay` caps the actions it takes alone in a day; past it, it asks again.
`spendPerDayUsd` caps what its model calls cost in a day, read from the steps it reports; past it, new tasks are
refused until tomorrow.

**Data rules decide what you see, not what the agent gets.** With `data` in `setLimits`, every view of yours (a task,
the list, the export) comes masked: `hide` covers a field, `hash` turns it into `sha256:` and 12 hex (the same value,
the same fingerprint, so two can still be told apart), `keep` leaves it, and `auto` also covers what looks like an
email or a card. `keep: 'metrics'` keeps only the numbers. The agent and the task's caller always get the task whole,
so the work and a retry go on with the real input.

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

## Errors and retries

Every error is a `SpredrError`, with ai's own words, its `status` and its `trace`. Catch the base, or the case you
handle: `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404),
`ConflictError` (409), `RateLimitError` (429, with `retryAfter`), `InternalServerError` (5xx), `ConnectionError` and
`TimeoutError` (no answer). A task that ends badly is a `TaskError`.

A request is tried again only when that is safe: no answer came or spredr failed, on a call that does the same thing
twice (reads, updates, deletes, and a task asked with its own `key`). A 429, or a 503 «busy», is tried again whatever
the call when spredr says how long to wait (`Retry-After`): spredr says it only when it turned the request away before
doing anything. A cap reached comes straight back to you. Each side takes the same options:

| Option | Default | |
|---|---|---|
| `timeoutMs` | 75 000 | how long one request may take |
| `maxRetries` | 2 | how many more tries, when safe; 0 never |
| `retryDelayMs` | 500 | the first wait, doubling up to 8 s |
| `fetch` | the global one | a fetch of your own |

## Variables

spredr writes these into your services when you register an agent or link a backend. You only set `SPREDR_TOKEN`.

| Variable | Read by | What it is |
|---|---|---|
| `SPREDR_AGENT_ID`, `SPREDR_AGENT_KEY` | `Agent` | the agent's id and private key |
| `SPREDR_CALLER_ID`, `SPREDR_CALLER_KEY`, `SPREDR_AGENT` | `new Caller()` | the backend's id, its private key, the agent it calls |
| `SPREDR_AI_URL`, `SPREDR_AI_KEY` | `Agent`, `Caller` | where spredr's agents live, and its public key |
| `SPREDR_TOKEN` | `Spredr` | an API token of yours, made in the panel (Account › API tokens) |
| `PORT` | `Agent.listen()` | the port it listens on, 8080 by default |

## Plans

An agent runs as one of your plan's services, so Starter runs up to 6 and Pro up to 10. The plan also sets the tasks a
month, how much each agent remembers and how long finished tasks are kept. Exporting and traces are always included.

**Long tasks.** A task keeps up to its plan's steps and notes (1,000 today). Past it the task keeps working and
finishes as always: the steps after are not kept, its history in the panel marks where it reached the limit, and the
SDK says so once in the agent's logs. `tasks.steps(id)` hands over a task's whole history, a page at a time.
See [spredr.cloud/pricing](https://spredr.cloud/pricing).

## Without the SDK

It is plain HTTP and works from any language: signed requests one way, signed callbacks the other. The SDK has no
dependencies; write to us if you need the protocol for another language.

## License

Free to use, copy and adapt **to work with spredr**: in your own agents and backends, commercial ones included. It is
not open source: you may not publish it on its own or as a fork, or use it with a service other than spredr. The full
text is the [spredr SDK License](https://unpkg.com/@spredr/sdk/LICENSE), the `LICENSE` file inside this package (© 2026 Candhrly, LLC); the spredr name
and logo are covered by [`TRADEMARKS.md`](https://unpkg.com/@spredr/sdk/TRADEMARKS.md), next to it.

---

<p align="center">
  <a href="https://spredr.cloud"><img src="https://spredr.cloud/branding/icon/icon-192.png" alt="spredr" width="56"></a><br>
  <sub><a href="https://spredr.cloud">spredr.cloud</a> · © 2026 Candhrly, LLC · <a href="https://unpkg.com/@spredr/sdk/LICENSE">license</a></sub><br>
  <sub>Free to use with spredr. spredr and its logo are trademarks of Candhrly, LLC.</sub>
</p>
