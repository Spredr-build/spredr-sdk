// The agent itself, listening for real on a free port: it says hello with what it handles, takes only tasks ai signed,
// reports what its handler returns or throws, stops to ask, and reports each step, memory and later task.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { Agent, currentTask, type AgentOptions, type Handler } from '../src/index.ts';
import { agentKeys, deliver, delivery, fakeAi, until, type Route } from './helpers.ts';

async function running(t: TestContext, handlers: Record<string, Handler>, route?: Route, manifest: Partial<AgentOptions> = {}) {
  const keys = agentKeys();
  const ai = fakeAi(route);
  const agent = new Agent({ ...keys.options, fetch: ai.fetch, ...manifest });
  for (const [kind, handler] of Object.entries(handlers)) agent.on(kind, handler);
  const server = await agent.listen(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { ai, agent, server, give: (body: object) => deliver(server, keys.ai.privateKey, body), keys };
}

const resultOf = (ai: ReturnType<typeof fakeAi>, id = 'tsk_1') => until(() => ai.last(`/agent/tasks/${id}/result`)?.json as { attempt: number; result?: unknown; error?: string } | undefined);

test('it says hello with its manifest and the kinds it handles, the judge apart', async (t) => {
  const { ai } = await running(t, { reply: () => 'ok', grade: () => 'ok' }, undefined, { description: 'Answers the shop', judge: 'grade', sleepAfterMinutes: 15 });
  assert.deepEqual(ai.last('/agent/hello')?.json, { description: 'Answers the shop', judge: 'grade', sleepAfterMinutes: 15, tasks: [{ kind: 'reply' }] });
  assert.equal(ai.last('/agent/hello')?.headers['x-spredr-from'], 'ag_test');
});

test('it answers /health, and nothing but tasks elsewhere', async (t) => {
  const { server } = await running(t, {});
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/health`)).text(), 'ok');
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/spredr/task`)).status, 404, 'a GET is not a task');
});

test('a task not signed by ai is turned away, and its handler never runs', async (t) => {
  let ran = false;
  const { server, keys } = await running(t, { reply: () => { ran = true; return 'x'; } });
  assert.equal((await deliver(server, keys.agent.privateKey, delivery('reply', {}))).status, 401, 'signed with another key');
  assert.equal((await deliver(server, keys.ai.privateKey, delivery('reply', {}), 'ag_other')).status, 401, 'signed as someone else');
  assert.equal(ran, false);
});

test('a kind it does not handle is said back, not run', async (t) => {
  const { give } = await running(t, { reply: () => 'x' });
  const answer = await give(delivery('refund', {}));
  assert.equal(answer.status, 200);
  assert.match(String((await answer.json() as { error: string }).error), /does not handle «refund»/);
});

test('what the handler returns is the result, what it throws is the error; both carry the attempt', async (t) => {
  const { ai, give } = await running(t, {
    reply: (input) => ({ reply: `got ${(input as { text: string }).text}` }),
    broken: () => { throw new Error('the shop API is down'); },
    nothing: () => undefined as never,
  });
  assert.equal((await give(delivery('reply', { text: 'hola' }))).status, 202);
  assert.deepEqual(await resultOf(ai), { attempt: 1, result: { reply: 'got hola' } });
  await give(delivery('broken', {}, { id: 'tsk_2' }));
  assert.deepEqual(await resultOf(ai, 'tsk_2'), { attempt: 1, error: 'the shop API is down' });
  await give(delivery('nothing', {}, { id: 'tsk_3' }));
  assert.deepEqual(await resultOf(ai, 'tsk_3'), { attempt: 1, result: null }, 'nothing returned is a null result');
});

test('ctx carries the task, its lessons and whether it is a trial', async (t) => {
  let seen: unknown;
  const { ai, give } = await running(t, { reply: (_, ctx) => { seen = { id: ctx.task.id, lessons: ctx.lessons, trial: ctx.trial }; return 'ok'; } });
  await give(delivery('reply', {}, { lessons: ['Offer two times'], trial: true }));
  await resultOf(ai);
  assert.deepEqual(seen, { id: 'tsk_1', lessons: ['Offer two times'], trial: true });
});

test('ask stops the task while the question is open: no result is reported', async (t) => {
  let after = false;
  const { ai, give } = await running(t, {
    refund: async (_, ctx) => { await ctx.ask('refund', 'Refund ana?', { options: ['yes', 'no'] }); after = true; return 'refunded'; },
  }, (request) => (request.path === '/agent/tasks/tsk_1/pause' ? { body: { pause: { status: 'open', answer: null } } } : undefined));
  await give(delivery('refund', {}));
  await until(() => ai.last('/agent/tasks/tsk_1/pause'));
  assert.deepEqual(ai.last('/agent/tasks/tsk_1/pause')?.json, { attempt: 1, action: 'refund', question: 'Refund ana?', options: ['yes', 'no'] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ai.last('/agent/tasks/tsk_1/result'), undefined);
  assert.equal(after, false);
});

test('ask goes on at once when the action is free, and when the task comes back with its answer', async (t) => {
  const { ai, give } = await running(t, {
    refund: async (_, ctx) => ({ answer: await ctx.ask('refund', 'Refund ana?') }),
  }, (request) => (request.path.endsWith('/pause') ? { body: { pause: { status: 'answered', answer: { yes: true, note: 'auto' } } } } : undefined));
  await give(delivery('refund', {}));
  assert.deepEqual((await resultOf(ai)).result, { answer: { yes: true, note: 'auto' } }, 'free: the pause answers itself');
  await give(delivery('refund', {}, { id: 'tsk_2', resume: { pause: 'pz_1', action: 'refund', yes: false, note: 'not this one' } }));
  assert.deepEqual((await resultOf(ai, 'tsk_2')).result, { answer: { pause: 'pz_1', action: 'refund', yes: false, note: 'not this one' } });
  assert.equal(ai.last('/agent/tasks/tsk_2/pause'), undefined, 'coming back with the answer asks nothing new');
});

test('track times a step and reports it, with what usage reads; a failed step is reported and thrown', async (t) => {
  const { ai, give } = await running(t, {
    reply: async (_, ctx) => {
      const answer = await ctx.track('model', 'reply', async () => ({ usage: { in: 120, out: 30 } }), (value) => ({ model: 'claude-haiku-5-5', tokensIn: value.usage.in, tokensOut: value.usage.out }));
      await ctx.track('tool', 'orders.find', async () => { throw new Error('no such order'); }).catch(() => undefined);
      return answer.usage.in;
    },
  });
  await give(delivery('reply', {}));
  assert.equal((await resultOf(ai)).result, 120);
  const steps = ai.seen.filter((one) => one.path === '/agent/tasks/tsk_1/steps').map((one) => (one.json as { steps: Record<string, unknown>[] }).steps[0]);
  assert.equal(steps.length, 2);
  assert.deepEqual({ kind: steps[0]?.kind, name: steps[0]?.name, model: steps[0]?.model, tokensIn: steps[0]?.tokensIn, tokensOut: steps[0]?.tokensOut }, { kind: 'model', name: 'reply', model: 'claude-haiku-5-5', tokensIn: 120, tokensOut: 30 });
  assert.equal(typeof steps[0]?.ms, 'number');
  assert.deepEqual({ kind: steps[1]?.kind, ok: steps[1]?.ok, detail: steps[1]?.detail }, { kind: 'tool', ok: false, detail: 'no such order' });
});

test('a fact ai did not keep (a full memory) comes back null and the task goes on to its result', async (t) => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...parts: unknown[]) => { warned.push(parts.join(' ')); };
  t.after(() => { console.warn = warn; });
  const { ai, give } = await running(t, {
    reply: async (_, ctx) => {
      const fact = await ctx.memory.remember('customer:ana', 'Prefiere los martes');
      return fact === null ? 'answered anyway' : 'kept';
    },
  }, (request) => (request.path === '/agent/memory' ? { body: { kept: false, fact: null, why: "Not kept: storio's memory is full, 10.00 of 10.00 MB" } } : undefined));
  await give(delivery('reply', {}));
  assert.equal((await resultOf(ai)).result, 'answered anyway');
  assert.ok(warned.some((line) => /memory: Not kept: storio's memory is full/.test(line)), 'why is in its logs');
});

test('memory, progress, steps and later tasks go to ai, signed by the agent', async (t) => {
  const { ai, give } = await running(t, {
    reply: async (_, ctx) => {
      await ctx.progress({ step: 'looking' });
      await ctx.step({ kind: 'other', name: 'note', ms: 1 });
      await ctx.memory.remember('customer:ana', 'Asked about Sunday', { key: 'last' });
      const facts = await ctx.memory.recall({ scope: 'customer:ana', q: 'sunday' });
      await ctx.memory.forget('ft_9');
      // attack: an id the model was talked into never turns into another tenant's query
      await ctx.memory.forget('ft_9?tenant=shop_a&');
      await ctx.later('follow-up', { customer: 'ana' }, new Date('2026-12-01T09:00:00Z'), 'ana-follow');
      return facts.length;
    },
  }, (request) => {
    if (request.path === '/agent/memory') return { body: { kept: true, fact: { id: 'ft_1' } } };
    if (request.path.startsWith('/agent/memory?')) return { body: { facts: [{ id: 'ft_1' }] } };
    return undefined;
  });
  await give(delivery('reply', {}));
  assert.equal((await resultOf(ai)).result, 1);
  const calls = ai.seen.filter((one) => one.path !== '/agent/hello' && !one.path.endsWith('/result') && !one.path.endsWith('/steps')).map((one) => [one.method, one.path, one.json]);
  assert.deepEqual(calls, [
    ['POST', '/agent/tasks/tsk_1/progress', { attempt: 1, data: { step: 'looking' } }],
    // every memory call names its task: ai takes the tenant from it
    ['PUT', '/agent/memory', { task: 'tsk_1', scope: 'customer:ana', text: 'Asked about Sunday', key: 'last' }],
    ['GET', '/agent/memory?scope=customer%3Aana&q=sunday&task=tsk_1', undefined],
    ['DELETE', '/agent/memory/ft_9?task=tsk_1', undefined],
    ['DELETE', '/agent/memory/ft_9%3Ftenant%3Dshop_a%26?task=tsk_1', undefined],
    ['POST', '/agent/tasks', { kind: 'follow-up', input: { customer: 'ana' }, at: '2026-12-01T09:00:00.000Z', key: 'ana-follow' }],
  ]);
  // the note, then remember and later as steps carrying their memo, so the next run does neither again
  const steps = ai.seen.filter((one) => one.path === '/agent/tasks/tsk_1/steps').map((one) => (one.json as { steps: { kind: string; name: string; memo?: { key: string; value?: unknown } }[] }).steps[0]);
  assert.deepEqual(steps.map((step) => [step?.kind, step?.name, step?.memo]), [
    ['other', 'note', undefined],
    ['memory', 'remember', { key: 'memory:remember:customer:ana', value: { id: 'ft_1' } }],
    ['other', 'later follow-up', { key: 'other:later:follow-up' }],
  ]);
});

test('the agent reads the feedback on its tasks and proposes lessons', async (t) => {
  const { ai, agent } = await running(t, {}, (request) => (request.path.startsWith('/agent/feedback') ? { body: { feedback: [{ seq: 4 }] } } : undefined));
  assert.deepEqual(await agent.feedback(3), [{ seq: 4 }]);
  await agent.propose('Offer two times', 'three customers asked', ['tsk_1']);
  assert.equal(ai.seen.at(-2)?.path, '/agent/feedback?after=3');
  assert.deepEqual(ai.last('/agent/lessons')?.json, { text: 'Offer two times', why: 'three customers asked', sources: ['tsk_1'] });
});

test('without its variables an agent says which one is missing', () => {
  const keys = agentKeys();
  assert.throws(() => new Agent({ ...keys.options, aiKey: '' }), /SPREDR_AI_KEY is not set/);
  assert.throws(() => new Agent({ ...keys.options, id: '' }), /SPREDR_AGENT_ID is not set/);
});

test('what a task prints carries its id, and each task ends with a line of its own: its logs find it', async (t) => {
  const lines: string[] = [];
  const out: string[] = [];
  // what reaches the deployment's logs: the process's stdout, whatever console was given
  const write = process.stdout.write.bind(process.stdout);
  const listen = () => { process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write; };
  t.after(() => { process.stdout.write = write; });
  const { ai, give } = await running(t, {
    reply: async (_, ctx) => {
      listen();
      console.log('looking up the catalog for %s', 'demo-shop');
      console.info({ step: 'catalog' });
      await new Promise((resolve) => setTimeout(resolve, 1));
      console.log('still', ctx.task.id, currentTask());
      process.stdout.write = write;
      return 'ok';
    },
    broken: () => { throw new Error('the shop API is down'); },
  }, undefined, { log: (line) => lines.push(line) });
  await give(delivery('reply', {}));
  await resultOf(ai);
  await give(delivery('broken', {}, { id: 'tsk_2' }));
  await resultOf(ai, 'tsk_2');
  await until(() => lines.length >= 2);
  // console colours what it prints when the output is a terminal: the words are what this checks, not the colours
  assert.deepEqual(out.map(stripVTControlCharacters), ['[tsk_1] looking up the catalog for demo-shop\n', "[tsk_1] { step: 'catalog' }\n", '[tsk_1] still tsk_1 tsk_1\n'], 'a format string keeps its place; after an await it still knows its task');
  assert.match(lines.find((line) => line.startsWith('tsk_1')) ?? '', /^tsk_1 reply done in \d+\.\d s$/);
  assert.equal(lines.find((line) => line.startsWith('tsk_2')), 'tsk_2 broken failed: the shop API is down');
  assert.equal(currentTask(), null, 'outside a task, no task');
});
