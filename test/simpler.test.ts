// The shorter ways in: result() gives the result or throws, new Caller() reads its variables, a schema checks the input,
// ctx.model() reads the tokens itself, an answer is used for one question, and close() lets running tasks finish.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, Caller, newKeys, TaskError, type AgentOptions, type StandardSchemaV1 } from '../src/index.ts';
import { usageOf } from '../src/usage.ts';
import { agentKeys, BASE, deliver, delivery, fakeAi, until, type Route } from './helpers.ts';

const keyOf = newKeys().privateKey;
const caller = (route: Route) => new Caller({ id: 'cl_shop', key: keyOf, agent: 'shop', ai: BASE, fetch: fakeAi(route).fetch });

test('result() gives the result itself; a task that does not finish well throws a TaskError carrying it', async () => {
  const done = caller(() => ({ body: { task: { id: 'tsk_1', status: 'done', result: { reply: 'sí' } } } }));
  assert.deepEqual(await done.result('reply', { text: 'hola' }), { reply: 'sí' });
  for (const [status, words] of [['failed', /the shop API is down/], ['paused', /waits for an answer/], ['canceled', /canceled/]] as const) {
    const ended = caller(() => ({ body: { task: { id: 'tsk_1', status, error: status === 'failed' ? 'the shop API is down' : '' } } }));
    await assert.rejects(ended.result('reply', {}), (error: unknown) => error instanceof TaskError && error.task.status === status && words.test(error.message));
  }
});

test('new Caller() reads what spredr wrote into the service, the same as fromEnv', () => {
  const names = ['SPREDR_CALLER_ID', 'SPREDR_CALLER_KEY', 'SPREDR_AGENT', 'SPREDR_AI_URL'] as const;
  const before = names.map((name) => process.env[name]);
  try {
    Object.assign(process.env, { SPREDR_CALLER_ID: 'cl_shop', SPREDR_CALLER_KEY: keyOf, SPREDR_AGENT: 'shop', SPREDR_AI_URL: BASE });
    assert.ok(new Caller() instanceof Caller);
    assert.ok(Caller.fromEnv() instanceof Caller);
    delete process.env.SPREDR_CALLER_KEY;
    assert.throws(() => new Caller(), /SPREDR_CALLER_KEY is not set/);
  } finally {
    names.forEach((name, index) => {
      const value = before[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

test('usageOf reads the model and tokens from Claude, OpenAI and the AI SDK; anything else, nothing', () => {
  assert.deepEqual(usageOf({ model: 'claude-haiku-5-5', usage: { input_tokens: 120, output_tokens: 30 } }), { model: 'claude-haiku-5-5', tokensIn: 120, tokensOut: 30 });
  assert.deepEqual(usageOf({ model: 'gpt-x', usage: { prompt_tokens: 10, completion_tokens: 4 } }), { model: 'gpt-x', tokensIn: 10, tokensOut: 4 });
  assert.deepEqual(usageOf({ usage: { inputTokens: 7, outputTokens: 3 }, response: { modelId: 'claude-sonnet-5-5' } }), { model: 'claude-sonnet-5-5', tokensIn: 7, tokensOut: 3 });
  // the prompt cache, each part apart: Claude counts it beside input_tokens, OpenAI and the AI SDK inside it
  assert.deepEqual(usageOf({ model: 'claude-opus-5-5', usage: { input_tokens: 50, output_tokens: 9, cache_read_input_tokens: 4000, cache_creation_input_tokens: 600 } }),
    { model: 'claude-opus-5-5', tokensIn: 50, tokensOut: 9, cacheReadTokens: 4000, cacheWriteTokens: 600 });
  assert.deepEqual(usageOf({ model: 'gpt-x', usage: { prompt_tokens: 1000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 800 } } }), { model: 'gpt-x', tokensIn: 200, tokensOut: 4, cacheReadTokens: 800 });
  assert.deepEqual(usageOf({ model: 'gpt-x', usage: { input_tokens: 900, output_tokens: 2, input_tokens_details: { cached_tokens: 900 } } }), { model: 'gpt-x', tokensIn: 0, tokensOut: 2, cacheReadTokens: 900 });
  assert.deepEqual(usageOf({ usage: { inputTokens: 70, outputTokens: 3, cachedInputTokens: 60 }, response: { modelId: 'm' } }), { model: 'm', tokensIn: 10, tokensOut: 3, cacheReadTokens: 60 });
  assert.deepEqual(usageOf({ usage: { promptTokens: 5, completionTokens: 2 } }), { tokensIn: 5, tokensOut: 2 });
  assert.deepEqual(usageOf('text'), {});
  assert.deepEqual(usageOf({ usage: { input_tokens: 'many' } }), {});
});

async function running(t: TestContext, setup: (agent: Agent) => void, route?: Route, options: Partial<AgentOptions> = {}) {
  const keys = agentKeys();
  const ai = fakeAi(route);
  const agent = new Agent({ ...keys.options, fetch: ai.fetch, log: false, ...options });
  setup(agent);
  const server = await agent.listen(0);
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { ai, agent, server, give: (body: object) => deliver(server, keys.ai.privateKey, body) };
}

const resultOf = (ai: ReturnType<typeof fakeAi>, id = 'tsk_1') => until(() => ai.last(`/agent/tasks/${id}/result`)?.json as { result?: unknown; error?: string } | undefined);

test('ctx.model times the call and reports its model and tokens, read from the answer', async (t) => {
  const { ai, give } = await running(t, (agent) => agent.on('reply', async (_, ctx) => {
    const answer = await ctx.model(async () => ({ model: 'claude-haiku-5-5', usage: { input_tokens: 90, output_tokens: 12 }, content: [{ type: 'text', text: 'sí' }] }));
    return answer.content[0]?.text;
  }));
  await give(delivery('reply', {}));
  assert.equal((await resultOf(ai)).result, 'sí');
  const step = (ai.last('/agent/tasks/tsk_1/steps')?.json as { steps: Record<string, unknown>[] }).steps[0];
  assert.deepEqual({ kind: step?.kind, name: step?.name, model: step?.model, tokensIn: step?.tokensIn, tokensOut: step?.tokensOut }, { kind: 'model', name: 'claude-haiku-5-5', model: 'claude-haiku-5-5', tokensIn: 90, tokensOut: 12 });
});

// a schema as zod, valibot or arktype give one: only the Standard Schema face matters
const textInput: StandardSchemaV1<{ text: string }, { text: string; length: number }> = {
  '~standard': {
    version: 1, vendor: 'test',
    validate: (value) => (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string'
      ? { value: { text: value.text, length: value.text.length } }
      : { issues: [{ message: 'Required', path: ['text'] }] }),
  },
};

test('with a schema the handler gets what the schema made of the input; an input that does not match fails saying where', async (t) => {
  const { ai, give } = await running(t, (agent) => agent.on('reply', textInput, (input) => ({ length: input.length })));
  await give(delivery('reply', { text: 'hola' }));
  assert.deepEqual((await resultOf(ai)).result, { length: 4 });
  await give(delivery('reply', { txt: 'hola' }, { id: 'tsk_2' }));
  assert.equal((await resultOf(ai, 'tsk_2')).error, 'The input does not match: text: Required');
});

test('the answer a task comes back with answers one question: asking the same action again asks again', async (t) => {
  const { ai, give } = await running(t, (agent) => agent.on('refunds', async (_, ctx) => {
    const first = await ctx.ask('refund', 'Refund ana?');
    const second = await ctx.ask('refund', 'Refund luis?');
    return { first: first.yes, second: second.yes };
  }), (request) => (request.path.endsWith('/pause') ? { body: { pause: { status: 'open', answer: null } } } : undefined));
  await give(delivery('refunds', {}, { resume: { pause: 'pz_1', action: 'refund', yes: true } }));
  const asked = await until(() => ai.last('/agent/tasks/tsk_1/pause'));
  assert.equal((asked.json as { question: string }).question, 'Refund luis?', 'the second question is asked, not answered with the first answer');
});

test('close() takes no new task and waits for the running ones to finish', async (t) => {
  let finish: () => void = () => undefined;
  const { ai, agent, server, give } = await running(t, (one) => one.on('slow', () => new Promise((resolve) => { finish = () => resolve('done'); })));
  await give(delivery('slow', {}));
  await until(() => finish !== undefined);
  let closed = false;
  const closing = agent.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed, false, 'a task is still running');
  finish();
  await closing;
  assert.equal((await resultOf(ai)).result, 'done', 'the running task finished and was reported');
  assert.equal(server.listening, false);
});

test('a closing agent turns new tasks away with 503 and says so on /health; a task past the grace is left to ai', async (t) => {
  const { agent, server, give } = await running(t, (one) => one.on('stuck', () => new Promise(() => undefined)), undefined, { shutdownGraceMs: 30 });
  await give(delivery('stuck', {}));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const closing = agent.close();
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`).then((answer) => answer.status).catch(() => 503)), 503);
  assert.equal((await give(delivery('stuck', {}, { id: 'tsk_2' })).then((answer) => answer.status).catch(() => 503)), 503);
  await closing;
});

test('a result is sent again when ai failed; one ai already has is fine; one that cannot go is never turned into a failure', async (t) => {
  const lines: string[] = [];
  let resultTries = 0;
  const { ai, give } = await running(t, (agent) => agent.on('reply', () => 'sí'), (request) => {
    if (!request.path.endsWith('/result')) return undefined;
    resultTries += 1;
    if (request.path.includes('tsk_1')) return resultTries === 1 ? { status: 503 } : {};
    if (request.path.includes('tsk_2')) return { status: 409, body: { error: 'That attempt is over' } };
    return { status: 503 };
  }, { retryDelayMs: 1, log: (line) => lines.push(line) });
  await give(delivery('reply', {}));
  await until(() => ai.seen.filter((one) => one.path === '/agent/tasks/tsk_1/result').length === 2);
  await give(delivery('reply', {}, { id: 'tsk_2' }));
  await until(() => ai.last('/agent/tasks/tsk_2/result'));
  await give(delivery('reply', {}, { id: 'tsk_3' }));
  await until(() => lines.some((line) => line.includes('tsk_3') && line.includes('ai gives it again')));
  const sent = (id: string) => ai.seen.filter((one) => one.path === `/agent/tasks/${id}/result`).map((one) => one.json);
  assert.deepEqual(sent('tsk_1'), [{ attempt: 1, result: 'sí' }, { attempt: 1, result: 'sí' }], 'tried again after the 503');
  assert.equal(sent('tsk_2').length, 1, 'a 409: ai has it already');
  assert.ok(sent('tsk_3').every((body) => (body as { result?: string }).result === 'sí'), 'never reported as an error');
  assert.deepEqual(lines.filter((line) => line.includes('tsk_2')), ['tsk_2 reply done in 0.0 s'], 'a 409 says nothing more than its task\'s line');
  assert.ok(lines.some((line) => line.includes('tsk_3') && /ai gives it again/.test(line)));
});

test('coming back with its journal, a task asked A then B gets both answers and asks nothing again: no loop', async (t) => {
  const { ai, give } = await running(t, (agent) => agent.on('refunds', async (_, ctx) => {
    const refund = await ctx.ask('refund', 'Refund ana?');
    const notify = await ctx.ask('notify', 'Tell luis?');
    return { refund: refund.yes, notify: notify.yes };
  }));
  await give(delivery('refunds', {}, { answers: [{ pause: 'pz_1', action: 'refund', yes: true }, { pause: 'pz_2', action: 'notify', yes: false }] }));
  assert.deepEqual((await resultOf(ai)).result, { refund: true, notify: false });
  assert.equal(ai.last('/agent/tasks/tsk_1/pause'), undefined);
});

test('a finished step is not done again: it gives back what it gave, and is not reported twice', async (t) => {
  let calls = 0;
  const { ai, give } = await running(t, (agent) => agent.on('reply', async (_, ctx) => {
    const message = await ctx.model(async () => { calls += 1; return { model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: 1 }, text: 'fresh' }; });
    const charged = await ctx.track('tool', 'stripe.charge', async () => { calls += 1; return { id: 'ch_new' }; });
    const answer = await ctx.ask('refund', 'Refund?');
    return { text: message.text, charge: charged.id, yes: answer.yes };
  }));
  await give(delivery('reply', {}, {
    answers: [{ pause: 'pz_1', action: 'refund', yes: true }],
    memo: [{ key: 'model:', has: true, value: { model: 'claude-haiku-5-5', text: 'from the first run' } }, { key: 'tool:stripe.charge', has: true, value: { id: 'ch_first' } }],
  }));
  assert.deepEqual((await resultOf(ai)).result, { text: 'from the first run', charge: 'ch_first', yes: true });
  assert.equal(calls, 0, 'neither the model nor the charge ran again');
  assert.equal(ai.last('/agent/tasks/tsk_1/steps'), undefined, 'nothing reported twice');
});

test('when the handler takes another way, the journal stops there and the rest runs for real', async (t) => {
  const ran: string[] = [];
  const { ai, give } = await running(t, (agent) => agent.on('reply', async (_, ctx) => {
    await ctx.track('tool', 'first', async () => { ran.push('first'); return 1; });
    await ctx.track('tool', 'other', async () => { ran.push('other'); return 2; });
    await ctx.track('tool', 'third', async () => { ran.push('third'); return 3; });
    return ran;
  }));
  await give(delivery('reply', {}, { memo: [{ key: 'tool:first', has: true, value: 1 }, { key: 'tool:second', has: true, value: 2 }, { key: 'tool:third', has: true, value: 3 }] }));
  assert.deepEqual((await resultOf(ai)).result, ['other', 'third'], 'first replayed; at «other» the way changed, so third runs too');
});

test('a question about another action than the one answered asks for real', async (t) => {
  const { ai, give } = await running(t, (agent) => agent.on('reply', async (_, ctx) => ({ answer: await ctx.ask('notify', 'Tell luis?') })),
    (request) => (request.path.endsWith('/pause') ? { body: { pause: { status: 'open', answer: null } } } : undefined));
  await give(delivery('reply', {}, { answers: [{ pause: 'pz_1', action: 'refund', yes: true }] }));
  assert.equal((await until(() => ai.last('/agent/tasks/tsk_1/pause'))).json && (ai.last('/agent/tasks/tsk_1/pause')?.json as { action: string }).action, 'notify');
});

test('what a step gives back travels as JSON; too big or not JSON, the step keeps no memo and runs again next time', async (t) => {
  const { ai, give } = await running(t, (agent) => agent.on('reply', async (_, ctx) => {
    await ctx.track('tool', 'nothing', async () => undefined);
    await ctx.track('tool', 'big', async () => 'x'.repeat(300 * 1024));
    await ctx.track('tool', 'circular', async () => { const loop: { self?: unknown } = {}; loop.self = loop; return loop; });
    return 'ok';
  }));
  await give(delivery('reply', {}));
  await resultOf(ai);
  const memos = ai.seen.filter((one) => one.path === '/agent/tasks/tsk_1/steps').flatMap((one) => (one.json as { steps: { name: string; memo?: unknown }[] }).steps).map((step) => [step.name, step.memo]);
  assert.deepEqual(memos, [['nothing', { key: 'tool:nothing' }], ['big', undefined], ['circular', undefined]]);
});

test('a step that gave back nothing gives back nothing again', async (t) => {
  let ran = false;
  const { ai, give } = await running(t, (agent) => agent.on('reply', async (_, ctx) => ({ was: await ctx.track('tool', 'send', async () => { ran = true; }) ?? 'nothing' })));
  await give(delivery('reply', {}, { memo: [{ key: 'tool:send', has: false, value: null }] }));
  assert.deepEqual((await resultOf(ai)).result, { was: 'nothing' });
  assert.equal(ran, false);
});

test('attack: a yes given to one amount is never reused for another; the same question about the same data still is', async (t) => {
  const refunded: number[] = [];
  const { ai, give } = await running(t, (agent) => agent.on('refunds', async (input, ctx) => {
    const amount = (input as { amount: number }).amount;
    const answer = await ctx.ask('refund', `Refund ${amount} to ana?`, { data: { to: 'ana', amount } });
    if (answer.yes) refunded.push(amount);
    return { yes: answer.yes };
  }));
  const approved = [{ pause: 'pz_1', action: 'refund', question: 'Refund 10 to ana?', data: { amount: 10, to: 'ana' }, yes: true }];
  // the re-run asks about 1000: the yes for 10 is not its answer, it asks again for real
  await give(delivery('refunds', { amount: 1000 }, { answers: approved }));
  await until(() => ai.last('/agent/tasks/tsk_1/pause'));
  assert.deepEqual(refunded, [], 'nothing refunded on someone else\'s yes');
  // the same question about the same data (keys in another order) is the one answered
  await give(delivery('refunds', { amount: 10 }, { id: 'tsk_2', answers: approved }));
  await until(() => ai.last('/agent/tasks/tsk_2/result'));
  assert.deepEqual(refunded, [10]);
});

test('steps travel in groups: hundreds of them in a few calls, all before the result, in order', async (t) => {
  const { ai, give } = await running(t, (agent) => agent.on('reply', async (_, ctx) => {
    for (let index = 1; index <= 120; index += 1) await ctx.step({ kind: 'tool', name: `step ${index}`, ms: 1 });
    return 'ok';
  }));
  await give(delivery('reply', {}));
  await resultOf(ai);
  const sends = ai.seen.filter((one) => one.path === '/agent/tasks/tsk_1/steps');
  const names = sends.flatMap((one) => (one.json as { steps: { name: string }[] }).steps.map((step) => step.name));
  assert.equal(names.length, 120, 'every step reached ai');
  assert.deepEqual(names.slice(0, 3), ['step 1', 'step 2', 'step 3'], 'in the order they were taken');
  assert.ok(sends.length <= 3, `in a few calls, not one each: ${sends.length}`);
  const result = ai.seen.findIndex((one) => one.path.endsWith('/result'));
  const lastSteps = ai.seen.map((one) => one.path.endsWith('/steps')).lastIndexOf(true);
  assert.ok(lastSteps < result, 'all of them before the result');
});
