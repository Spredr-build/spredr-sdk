// One agent, many tenants at once (users, accounts, teams, businesses): a tenant session sends every task as that
// tenant's and reads what is its own; the agent's handler knows whom it works for; and an agent can live inside a
// server you already run.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, Caller, newKeys, Spredr, type Handler } from '../src/index.ts';
import { privateKeyOf, signedHeaders, AI_SIGNER } from '../src/sign.ts';
import { agentKeys, BASE, delivery, fakeAi, until } from './helpers.ts';

const ANY = { task: {}, tasks: [], pauses: [], tenant: {}, tenants: [], caps: {}, forgotten: {}, freedom: {}, lesson: {}, lessons: [] };

test('a tenant session sends each call as that tenant\'s, to the path ai expects', async () => {
  const keys = newKeys();
  const cases: [string, (shop: ReturnType<Caller['for']>) => Promise<unknown>, string, string, unknown][] = [
    ['ask', (shop) => shop.ask('reply', { text: 'hola' }, { thread: 'wa:+573001112233' }), 'POST', '/agents/storio/tasks', { kind: 'reply', input: { text: 'hola' }, thread: 'wa:+573001112233', tenant: 'shop_1' }],
    ['list', (shop) => shop.list({ status: 'failed' }), 'GET', '/agents/storio/tasks?status=failed&tenant=shop_1', undefined],
    ['pauses', (shop) => shop.pauses(), 'GET', '/agents/storio/pauses?tenant=shop_1', undefined],
    ['usage', (shop) => shop.usage(), 'GET', '/agents/storio/tenants/shop_1', undefined],
    ['setLimits', (shop) => shop.setLimits({ spendPerDayUsd: 0.5, facts: null }), 'PUT', '/agents/storio/tenants/shop_1/limits', { spendPerDayUsd: 0.5, facts: null }],
    ['forget', (shop) => shop.forget(), 'DELETE', '/agents/storio/tenants/shop_1', undefined],
    ['freedom', (shop) => shop.freedom(), 'GET', '/agents/storio/freedom?tenant=shop_1', undefined],
    ['setFreedom', (shop) => shop.setFreedom('discount', 'auto'), 'PUT', '/agents/storio/freedom/discount', { level: 'auto', tenant: 'shop_1' }],
    ['lessons', (shop) => shop.lessons(), 'GET', '/agents/storio/lessons?tenant=shop_1', undefined],
    ['teach', (shop) => shop.teach('Nunca agendes los domingos'), 'POST', '/agents/storio/lessons', { text: 'Nunca agendes los domingos', why: '', tenant: 'shop_1' }],
    ['decide', (shop) => shop.decide('ls_1', 'retire'), 'POST', '/agents/storio/lessons/ls_1', { decision: 'retire' }],
  ];
  for (const [what, call, method, path, body] of cases) {
    const ai = fakeAi(() => ({ body: ANY }));
    const shop = new Caller({ id: 'cl_shops', key: keys.privateKey, agent: 'storio', ai: BASE, fetch: ai.fetch }).for('shop_1');
    await call(shop);
    const [request] = ai.seen;
    assert.equal(request?.method, method, what);
    assert.equal(request?.path, path, what);
    assert.deepEqual(request?.json, body, what);
    assert.equal(request?.headers['x-spredr-from'], 'cl_shops', `${what}: signed as the backend`);
  }
});

test('a tenant named on one ask wins over the session\'s, and a bare caller names none', async () => {
  const keys = newKeys();
  const ai = fakeAi(() => ({ body: ANY }));
  const caller = new Caller({ id: 'cl_shops', key: keys.privateKey, agent: 'storio', ai: BASE, fetch: ai.fetch });
  await caller.ask('reply', 'x');
  await caller.for('shop_1').ask('reply', 'y', { tenant: 'shop_2' });
  assert.deepEqual(ai.seen.map((one) => (one.json as { tenant?: string }).tenant), [undefined, 'shop_2']);
});

test('the owner reaches a tenant the same way, lists them with what each used, and caps every tenant at once', async () => {
  const ai = fakeAi(() => ({ body: ANY }));
  const shop = new Spredr({ token: 'spr_owner', ai: BASE, fetch: ai.fetch }).agent('storio');
  await shop.tenants({ days: 7, limit: 20 });
  await shop.setTenantLimits({ spendPerDayUsd: 1 });
  await shop.for('shop_1').usage();
  await shop.forget('customer:ana', 'shop_1');
  await shop.memory({ tenant: 'shop_1' });
  assert.deepEqual(ai.seen.map((one) => [one.method, one.path, one.json]), [
    ['GET', '/agents/storio/tenants?days=7&limit=20', undefined],
    ['PUT', '/agents/storio/tenants/*/limits', { spendPerDayUsd: 1 }],
    ['GET', '/agents/storio/tenants/shop_1', undefined],
    ['POST', '/agents/storio/memory/forget', { scope: 'customer:ana', tenant: 'shop_1' }],
    ['GET', '/agents/storio/memory?tenant=shop_1', undefined],
  ]);
  assert.ok(ai.seen.every((one) => one.headers.authorization === 'Bearer spr_owner'));
});

/** An agent that is not listening: its tasks come through handle(), as inside someone else's server. */
function mounted(t: TestContext, handlers: Record<string, Handler>) {
  const keys = agentKeys();
  const ai = fakeAi();
  const agent = new Agent({ ...keys.options, fetch: ai.fetch, log: false });
  for (const [kind, handler] of Object.entries(handlers)) agent.on(kind, handler);
  t.after(() => agent.close());
  const signed = (body: object, path = '/spredr/task', signer = AI_SIGNER) => {
    const text = JSON.stringify(body);
    return { method: 'POST', path, headers: signedHeaders(signer, privateKeyOf(keys.ai.privateKey), 'POST', path, text), body: Buffer.from(text) };
  };
  return { ai, agent, signed };
}

test('the handler knows whom it works for, and a task it schedules is for the same tenant and thread', async (t) => {
  let seen: { tenant: string; thread: string | null } | null = null;
  const { ai, agent, signed } = mounted(t, {
    reply: async (_, ctx) => {
      seen = { tenant: ctx.tenant, thread: ctx.thread };
      await ctx.later('follow-up', {}, new Date('2026-12-01T09:00:00Z'));
      return 'ok';
    },
  });
  const job = delivery('reply', {});
  const answer = await agent.handle(signed({ ...job, task: { ...job.task, tenant: 'shop_1', thread: 'wa:+573001112233' } }));
  assert.equal(answer.status, 202);
  await until(() => ai.last('/agent/tasks/tsk_1/result'));
  assert.deepEqual(seen, { tenant: 'shop_1', thread: 'wa:+573001112233' });
  assert.deepEqual(ai.last('/agent/tasks')?.json, { kind: 'follow-up', input: {}, at: '2026-12-01T09:00:00.000Z', tenant: 'shop_1', thread: 'wa:+573001112233' });
});

test('a task from an ai without tenants reads as no one in particular', async (t) => {
  let tenant: string | null = null;
  const { ai, agent, signed } = mounted(t, { reply: (_, ctx) => { tenant = ctx.tenant; return 'ok'; } });
  await agent.handle(signed(delivery('reply', {})));
  await until(() => ai.last('/agent/tasks/tsk_1/result'));
  assert.equal(tenant, '');
});

test('inside your own server: handle() takes only signed tasks on its path, start() says hello, close() turns new ones away', async (t) => {
  let ran = 0;
  const { ai, agent, signed } = mounted(t, { reply: () => { ran += 1; return 'ok'; } });
  assert.equal(agent.path, '/spredr/task');
  assert.equal((await agent.handle(signed(delivery('reply', {}), '/elsewhere'))).status, 404);
  const forged = signed(delivery('reply', {}), '/spredr/task', 'ag_other');
  assert.equal((await agent.handle(forged)).status, 401);
  assert.equal((await agent.handle({ ...signed(delivery('reply', {})), method: 'GET' })).status, 404);
  await agent.start();
  assert.ok(ai.last('/agent/hello'), 'hello said');
  assert.equal((await agent.handle(signed(delivery('reply', {})))).status, 202);
  await until(() => ran === 1);
  await agent.close();
  const late = await agent.handle(signed(delivery('reply', {}, { id: 'tsk_2' })));
  assert.equal(late.status, 503);
  assert.equal(ran, 1);
});
