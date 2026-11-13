// A backend linked to one agent: every call goes where ai expects it, signed as the backend; run waits however long it
// takes; and Caller.fromEnv reads what spredr wrote into the service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Caller, newKeys } from '../src/index.ts';
import { aiVerifier } from '../src/sign.ts';
import { BASE, fakeAi, type Route } from './helpers.ts';

const mine = newKeys();
const caller = (route?: Route) => {
  const ai = fakeAi(route);
  return { ai, shop: new Caller({ id: 'cl_shop', key: mine.privateKey, agent: 'shop', ai: BASE, fetch: ai.fetch }) };
};

test('each call goes to its path with its method and body', async () => {
  const at = new Date('2026-12-01T10:00:00Z');
  const cases: [string, (shop: Caller) => Promise<unknown>, string, string, unknown][] = [
    ['ask', (shop) => shop.ask('reply', { text: 'hola' }, { key: 'msg-1', wait: 300, at, thread: 'customer:ana', title: 'Pregunta de Ana' }), 'POST', '/agents/shop/tasks',
      { kind: 'reply', input: { text: 'hola' }, key: 'msg-1', wait: 60, at: '2026-12-01T10:00:00.000Z', thread: 'customer:ana', title: 'Pregunta de Ana' }],
    ['ask, bare', (shop) => shop.ask('reply', 'hola'), 'POST', '/agents/shop/tasks', { kind: 'reply', input: 'hola' }],
    ['get', (shop) => shop.get('tsk_1'), 'GET', '/tasks/tsk_1', undefined],
    ['list', (shop) => shop.list({ status: 'failed', limit: 5, thread: 'customer:ana' }), 'GET', '/agents/shop/tasks?status=failed&limit=5&thread=customer%3Aana', undefined],
    ['events', (shop) => shop.events('tsk_1', 3, 20), 'GET', '/tasks/tsk_1/events?after=3&wait=20', undefined],
    ['steps', (shop) => shop.steps('tsk_1'), 'GET', '/tasks/tsk_1/steps', undefined],
    ['cancel', (shop) => shop.cancel('tsk_1'), 'POST', '/tasks/tsk_1/cancel', {}],
    ['pauses', (shop) => shop.pauses(), 'GET', '/agents/shop/pauses', undefined],
    ['answer', (shop) => shop.answer('pz_1', { yes: false, note: 'no refunds on sale items' }), 'POST', '/pauses/pz_1/answer', { yes: false, note: 'no refunds on sale items' }],
    ['feedback', (shop) => shop.feedback('tsk_1', 'bad', { correction: { reply: 'two times' } }), 'POST', '/tasks/tsk_1/feedback', { verdict: 'bad', correction: { reply: 'two times' } }],
  ];
  for (const [what, call, method, path, body] of cases) {
    const { ai, shop } = caller(() => ({ body: { task: {}, tasks: [], events: [], steps: [], pauses: [], pause: {}, feedback: {} } }));
    await call(shop);
    const [request] = ai.seen;
    assert.equal(request?.method, method, what);
    assert.equal(request?.path, path, what);
    assert.deepEqual(request?.json, body, what);
    assert.equal(request?.headers['x-spredr-from'], 'cl_shop', `${what}: signed as the backend`);
  }
});

test('run asks, then follows the task in rounds of a minute until it leaves the line', async () => {
  const states = ['queued', 'running', 'running', 'done'];
  const { ai, shop } = caller((request) => {
    if (request.method === 'POST') return { body: { task: { id: 'tsk_1', status: 'queued' } } };
    return { body: { task: { id: 'tsk_1', status: states.shift() ?? 'done', result: { reply: 'sí' } } } };
  });
  const task = await shop.run('reply', { text: 'hola' });
  assert.equal(task.status, 'done');
  assert.deepEqual(task.result, { reply: 'sí' });
  assert.deepEqual(ai.seen.map((one) => `${one.method} ${one.path}`), ['POST /agents/shop/tasks', 'GET /tasks/tsk_1', 'GET /tasks/tsk_1?wait=60', 'GET /tasks/tsk_1?wait=60', 'GET /tasks/tsk_1?wait=60']);
  assert.equal((ai.seen[0]?.json as { wait: number }).wait, 60, 'the first answer may already be the outcome');
});

test('a paused task is an outcome: run returns it for someone to answer', async () => {
  const { shop } = caller((request) => ({ body: { task: { id: 'tsk_1', status: request.method === 'POST' ? 'running' : 'paused' } } }));
  assert.equal((await shop.run('refund', {})).status, 'paused');
});

test('Caller.fromEnv reads the variables spredr writes, and names the one that is missing', () => {
  const names = ['SPREDR_CALLER_ID', 'SPREDR_CALLER_KEY', 'SPREDR_AGENT', 'SPREDR_AI_URL', 'SPREDR_AI_KEY'] as const;
  const before = names.map((name) => process.env[name]);
  try {
    Object.assign(process.env, { SPREDR_CALLER_ID: 'cl_shop', SPREDR_CALLER_KEY: mine.privateKey, SPREDR_AGENT: 'shop', SPREDR_AI_URL: BASE, SPREDR_AI_KEY: newKeys().publicKey });
    assert.ok(Caller.fromEnv() instanceof Caller);
    delete process.env.SPREDR_AGENT;
    assert.throws(() => Caller.fromEnv(), /SPREDR_AGENT is not set/);
    assert.ok(Caller.fromEnv({ agent: 'shop' }), 'an option stands in for a variable');
  } finally {
    names.forEach((name, index) => {
      const value = before[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

test('its requests are signed with its own key: its public half checks them, no other key does', async () => {
  const { ai, shop } = caller(() => ({ body: { pauses: [] } }));
  await shop.pauses();
  const [request] = ai.seen;
  assert.ok(request);
  // ai finds the key by x-spredr-from and checks the same bytes; aiVerifier checks that scheme when the signer reads «ai»
  const asChecked = { method: 'GET', path: '/agents/shop/pauses', headers: { ...request.headers, 'x-spredr-from': 'ai' }, body: '' };
  assert.equal(aiVerifier(mine.publicKey)(asChecked), true);
  assert.equal(aiVerifier(newKeys().publicKey)(asChecked), false);
});

test('attack: a genuine ai-signed callback forwarded from another caller is not taken', async () => {
  const { Caller, newKeys } = await import('../src/index.ts');
  const { signedHeaders, privateKeyOf } = await import('../src/sign.ts');
  const ai = newKeys();
  const mine = newKeys();
  const caller = new Caller({ id: 'cl_mine', key: mine.privateKey, ai: 'https://api.spredr.cloud/ai', aiKey: ai.publicKey, agent: 'shop' });
  const signedBody = (body: object) => { const text = JSON.stringify(body); return { method: 'POST', path: '/hooks/spredr', headers: signedHeaders('ai', privateKeyOf(ai.privateKey), 'POST', '/hooks/spredr', text), body: Buffer.from(text) }; };
  const task = { id: 'tsk_1', state: 'done' };
  assert.equal(caller.callback(signedBody({ to: { caller: 'cl_other' }, event: 'done', task })), null);
  assert.notEqual(caller.callback(signedBody({ to: { caller: 'cl_mine' }, event: 'done', task })), null);
});

test('attack: an id never leaves its own path segment: «../x?» reaches the method\'s own route, encoded, never another', async () => {
  const { ai, shop } = caller(() => ({ body: { task: {}, events: [], steps: [], pause: {}, feedback: {}, lesson: {} } }));
  const evil = '../agents/storio/rotate?';
  const segment = encodeURIComponent(evil);
  await shop.cancel(evil);
  await shop.get(evil);
  await shop.events(evil);
  await shop.steps(evil);
  await shop.feedback(evil, 'good');
  await shop.answer(evil, { yes: true });
  await shop.for('shop_a').decide(evil, 'accept');
  assert.deepEqual(ai.seen.map((request) => request.path.split('?')[0]), [
    `/tasks/${segment}/cancel`, `/tasks/${segment}`, `/tasks/${segment}/events`, `/tasks/${segment}/steps`, `/tasks/${segment}/feedback`,
    `/pauses/${segment}/answer`, `/agents/shop/lessons/${segment}`,
  ]);
});
