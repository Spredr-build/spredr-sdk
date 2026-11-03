// The SDK against the real ai, over HTTP: an owner registers an agent built with the SDK, links a backend that signs
// with its own key, and the three of them go through a task, a question, memory and a lesson.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { newAtRestKey, newSigningKeys } from '@spreadr/crypto';
import { buildAi, memoryStores } from '../../ai/src/app.ts';
import { AI_SIGNER, signedHeaders } from '../../ai/src/bond/sign.ts';
import { fakeSpredr, OWNER, TOKEN } from '../../ai/test/helpers.ts';
import { Agent, Caller, newKeys, Spredr, SpredrError } from '../src/index.ts';
import type { Json } from '../src/types.ts';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const textOf = (input: Json): string => (typeof input === 'object' && input !== null && !Array.isArray(input) && typeof input.text === 'string' ? input.text : '');

async function world(t: TestContext) {
  const agentPort = await freePort();
  const aiKeys = newSigningKeys();
  const spredrWorld = fakeSpredr([
    { name: 'shop-agent', href: `http://127.0.0.1:${agentPort}`, healthPath: '/health', stopped: false, stoppedBy: '', liveRelease: 1, ownerId: OWNER.id, vars: {}, deploys: 0 },
  ]);
  const aiPort = await freePort();
  const real = buildAi({ stores: memoryStores(), spredr: spredrWorld.spredr, ai: { url: `http://127.0.0.1:${aiPort}`, signingKey: aiKeys.privateKey, atRestKey: newAtRestKey() }, allowLocalHttp: true });
  const url = await real.app.listen({ port: aiPort, host: '127.0.0.1' });
  const ticker = setInterval(() => void real.tick(), 200);
  t.after(async () => {
    clearInterval(ticker);
    await real.app.close();
  });
  const spredr = new Spredr({ token: TOKEN, ai: url });
  return { url, spredr, spredrWorld, aiKeys, agentPort, t };
}

test('owner, agent and backend through the SDK: a task, a question, memory and a lesson', async (t) => {
  const { url, spredr, spredrWorld, aiKeys, agentPort } = await world(t);
  const registered = await spredr.register('shop', 'shop-agent');
  assert.equal(registered.state, 'new');
  const vars = spredrWorld.services.get('shop-agent')?.vars ?? {};

  const agent = new Agent({ id: vars.SPREDR_AGENT_ID, key: vars.SPREDR_AGENT_KEY, ai: url, aiKey: vars.SPREDR_AI_KEY, actions: [{ name: 'discount' }], timeoutSeconds: 30 })
    .on('reply', async (input, ctx) => {
      const text = textOf(input);
      const known = await ctx.memory.recall({ scope: 'customer:ana' });
      if (!ctx.trial) await ctx.memory.remember('customer:ana', `dijo: ${text}`, { key: 'last' });
      if (text.includes('descuento')) {
        const answer = await ctx.ask('discount', '¿10 % para Ana?', { options: ['sí', 'no'] });
        return { reply: answer.yes ? 'Te di 10 %.' : 'Esta vez no.', lessons: ctx.lessons };
      }
      return { reply: `Hola Ana${known.length ? `, recuerdo: ${known[0]?.text}` : ''}`, lessons: ctx.lessons };
    });
  const server = await agent.listen(agentPort);
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal((await spredr.agent('shop').info()).state, 'awake');

  const keys = newKeys();
  const linked = await spredr.agent('shop').addCaller('shop-api', { publicKey: keys.publicKey });
  assert.equal(linked.privateKey, undefined, 'its own key: nothing secret comes back');
  const backend = new Caller({ id: linked.caller.id, key: keys.privateKey, agent: 'shop', ai: url, aiKey: aiKeys.publicKey });

  const first = await backend.run('reply', { text: 'hola' }, { key: 'msg-1' });
  assert.equal(first.status, 'done');
  assert.deepEqual(first.result, { reply: 'Hola Ana', lessons: [] });
  const second = await backend.run('reply', { text: '¿abren hoy?' });
  assert.deepEqual(second.result, { reply: 'Hola Ana, recuerdo: dijo: hola', lessons: [] });
  assert.equal((await backend.ask('reply', { text: 'otra' }, { key: 'msg-1' })).id, first.id, 'the same key is the same task');

  const asking = await backend.run('reply', { text: 'quiero un descuento' });
  assert.equal(asking.status, 'paused');
  const [question] = await backend.pauses();
  assert.equal(question?.question, '¿10 % para Ana?');
  await backend.answer(question?.id ?? '', { yes: true });
  const answered = await backend.settle(asking.id, 20_000);
  assert.equal(answered.status, 'done');
  assert.deepEqual(answered.result, { reply: 'Te di 10 %.', lessons: [] });

  await backend.feedback(first.id, 'bad', { correction: 'Saluda y ofrece horarios.' });
  const learned = await agent.feedback();
  assert.equal(learned[0]?.verdict, 'bad');
  await agent.propose('Ofrece dos horarios.', 'la saludó sin horarios', [first.id]);
  const [proposed] = await spredr.agent('shop').lessons();
  await spredr.agent('shop').decide(proposed?.id ?? '', 'accept');
  const version = await spredr.agent('shop').release();
  assert.equal(version.status, 'trial');
  await spredr.agent('shop').version(version.version, 'publish');
  const after = await backend.run('reply', { text: 'hola de nuevo' });
  assert.deepEqual((after.result as { lessons: string[] }).lessons, ['Ofrece dos horarios.']);

  const other = await spredr.agent('shop').tasks.ask('reply', { text: 'del dueño' });
  await assert.rejects(backend.get(other.id), (error: unknown) => error instanceof SpredrError && error.status === 404, 'a backend sees only its own tasks');
  assert.equal((await spredr.agent('shop').memory({ scope: 'customer:ana' })).length, 1);
});

test('a callback is believed only when ai signed it, once', async (t) => {
  const { url, aiKeys } = await world(t);
  const backend = new Caller({ id: 'cl_x', key: newKeys().privateKey, agent: 'shop', ai: url, aiKey: aiKeys.publicKey });
  const body = JSON.stringify({ event: 'task.done', task: { id: 'tsk_1', status: 'done' } });
  const headers = signedHeaders(AI_SIGNER, aiKeys.privateKey, 'POST', '/agent-done', body);
  assert.equal(backend.callback({ method: 'POST', path: '/agent-done', headers, body })?.event, 'task.done');
  assert.equal(backend.callback({ method: 'POST', path: '/agent-done', headers, body }), null, 'the same callback twice');
  const forged = signedHeaders(AI_SIGNER, newKeys().privateKey, 'POST', '/agent-done', body);
  assert.equal(backend.callback({ method: 'POST', path: '/agent-done', headers: forged, body }), null, 'signed by someone else');
  const fresh = signedHeaders(AI_SIGNER, aiKeys.privateKey, 'POST', '/agent-done', body);
  assert.equal(backend.callback({ method: 'POST', path: '/agent-done', headers: fresh, body: body.replace('done', 'failed') }), null, 'a body changed on the way');
});

test('steps tracked by the agent become its trace, its summary and its threads; the owner sees one inbox and sets limits', async (t) => {
  const { url, spredr, spredrWorld, aiKeys, agentPort } = await world(t);
  await spredr.register('shop', 'shop-agent');
  const vars = spredrWorld.services.get('shop-agent')?.vars ?? {};
  const agent = new Agent({ id: vars.SPREDR_AGENT_ID, key: vars.SPREDR_AGENT_KEY, ai: url, aiKey: vars.SPREDR_AI_KEY, tools: [{ name: 'orders.find', description: 'Busca un pedido' }] })
    .on('reply', async (input, ctx) => {
      await ctx.track('memory', 'Leyó customer:ana', () => ctx.memory.recall({ scope: 'customer:ana' }));
      const order = await ctx.track('tool', 'orders.find(1042)', async () => ({ id: 1042 }));
      const words = await ctx.track('model', 'Pensó', async () => ({ text: 'Hola', usage: { in: 120, out: 8 } }), (answer) => ({ model: 'claude-haiku-5-5', tokensIn: answer.usage.in, tokensOut: answer.usage.out, costUsd: 0.0002 }));
      return { reply: `${words.text} (${order.id}) ${textOf(input)}` };
    });
  const server = await agent.listen(agentPort);
  t.after(() => { server.closeAllConnections(); server.close(); });

  const keys = newKeys();
  const linked = await spredr.agent('shop').addCaller('shop-api', { publicKey: keys.publicKey });
  const backend = new Caller({ id: linked.caller.id, key: keys.privateKey, agent: 'shop', ai: url, aiKey: aiKeys.publicKey });
  const done = await backend.run('reply', { text: 'hola' }, { thread: 'customer:ana' });
  assert.equal(done.status, 'done');
  assert.equal(done.thread, 'customer:ana');
  const trace = await backend.steps(done.id);
  assert.deepEqual(trace.map((step) => step.kind), ['memory', 'tool', 'model']);
  assert.equal(trace[2]?.tokensIn, 120);

  const shop = spredr.agent('shop');
  const summary = await shop.summary();
  assert.equal(summary.tasks, 1);
  assert.equal(summary.tokens, 128);
  assert.deepEqual(summary.tools, [{ name: 'orders.find', uses: 1 }]);
  assert.deepEqual((await shop.threads()).map((thread) => `${thread.thread}:${thread.tasks}`), ['customer:ana:1']);
  assert.deepEqual((await shop.info()).tools, [{ name: 'orders.find', description: 'Busca un pedido', asks: false }]);
  assert.equal((await shop.setLimits({ spendPerDayUsd: 0.0001 })).limits?.spendPerDayUsd, 0.0001);
  await assert.rejects(backend.ask('reply', { text: 'otra' }), (error: unknown) => error instanceof SpredrError && error.status === 429, 'past its spend for today');
  assert.deepEqual(await spredr.inbox(), { questions: [], errors: [] });
});

test('the owner exports every task with its steps through the SDK', async (t) => {
  const { url, spredr, spredrWorld, agentPort } = await world(t);
  await spredr.register('shop', 'shop-agent');
  const vars = spredrWorld.services.get('shop-agent')?.vars ?? {};
  const agent = new Agent({ id: vars.SPREDR_AGENT_ID, key: vars.SPREDR_AGENT_KEY, ai: url, aiKey: vars.SPREDR_AI_KEY })
    .on('reply', async (_input, ctx) => ctx.track('tool', 'orders.find', async () => 'found'));
  const server = await agent.listen(agentPort);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const done = await spredr.agent('shop').tasks.run('reply', { text: 'x' });
  const rows = await spredr.agent('shop').export();
  assert.equal(rows[0]?.id, done.id);
  assert.equal(rows[0]?.steps.length, 1);
});
