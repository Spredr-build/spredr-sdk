// You, with your token: every call goes where ai expects it with the token, and the export arrives task by task.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Spredr, type OwnedAgent } from '../src/index.ts';
import { BASE, fakeAi } from './helpers.ts';

const ANY = { agents: [], agent: {}, summary: {}, threads: [], traces: null, caller: {}, callers: [], schedule: {}, hook: {}, facts: [], fact: {}, forgotten: 0, freedom: [], lessons: [], lesson: {}, versions: [], version: {} };

test('each owner call goes to its path with its method and body, carrying the token', async () => {
  const since = new Date('2026-11-01T00:00:00Z');
  const cases: [string, (spredr: Spredr, shop: OwnedAgent) => Promise<unknown>, string, string, unknown][] = [
    ['agents', (spredr) => spredr.agents(), 'GET', '/agents', undefined],
    ['register', (spredr) => spredr.register('shop', 'shop-agent', { redeploy: true }), 'POST', '/agents', { name: 'shop', service: 'shop-agent', redeploy: true }],
    ['keepToken', (spredr) => spredr.keepToken('spr_kept'), 'PUT', '/me/key', { token: 'spr_kept' }],
    ['inbox', (spredr) => spredr.inbox(48), 'GET', '/inbox?hours=48', undefined],
    ['info', (_, shop) => shop.info(), 'GET', '/agents/shop', undefined],
    ['summary', (_, shop) => shop.summary(6), 'GET', '/agents/shop/summary?hours=6', undefined],
    ['threads', (_, shop) => shop.threads(10), 'GET', '/agents/shop/threads?limit=10', undefined],
    ['setLimits', (_, shop) => shop.setLimits({ autoPerDay: 200, spendPerDayUsd: null }), 'PUT', '/agents/shop/limits', { autoPerDay: 200, spendPerDayUsd: null }],
    ['setTraces', (_, shop) => shop.setTraces({ endpoint: 'https://otel.example.com/v1/traces', withContent: true }), 'PUT', '/agents/shop/traces', { endpoint: 'https://otel.example.com/v1/traces', withContent: true }],
    ['traces', (_, shop) => shop.traces(), 'GET', '/agents/shop/traces', undefined],
    ['stopTraces', (_, shop) => shop.stopTraces(), 'DELETE', '/agents/shop/traces', undefined],
    ['remove', (_, shop) => shop.remove(), 'DELETE', '/agents/shop', undefined],
    ['rotateKey', (_, shop) => shop.rotateKey({ redeploy: true }), 'POST', '/agents/shop/rotate', { redeploy: true }],
    ['addCaller', (_, shop) => shop.addCaller('shop-api', { service: 'shop-api', everything: true, callbackUrl: 'https://shop.example.com/cb' }), 'POST', '/agents/shop/callers', { name: 'shop-api', service: 'shop-api', everything: true, callbackUrl: 'https://shop.example.com/cb' }],
    ['callers', (_, shop) => shop.callers(), 'GET', '/agents/shop/callers', undefined],
    ['removeCaller', (_, shop) => shop.removeCaller('cl_1'), 'DELETE', '/agents/shop/callers/cl_1', undefined],
    ['schedule', (_, shop) => shop.schedule('morning', 'digest', '0 8 * * *', { tz: 'America/Bogota' }), 'POST', '/agents/shop/schedules', { name: 'morning', kind: 'digest', cron: '0 8 * * *', tz: 'America/Bogota' }],
    ['hook', (_, shop) => shop.hook('orders', 'new-order'), 'POST', '/agents/shop/hooks', { name: 'orders', kind: 'new-order' }],
    ['memory', (_, shop) => shop.memory({ scope: 'customer:ana', limit: 3 }), 'GET', '/agents/shop/memory?scope=customer%3Aana&limit=3', undefined],
    ['editFact', (_, shop) => shop.editFact('ft_1', 'likes mornings'), 'PATCH', '/agents/shop/memory/ft_1', { text: 'likes mornings' }],
    ['forget', (_, shop) => shop.forget('customer:ana'), 'POST', '/agents/shop/memory/forget', { scope: 'customer:ana' }],
    ['freedom', (_, shop) => shop.freedom(), 'GET', '/agents/shop/freedom', undefined],
    ['setFreedom', (_, shop) => shop.setFreedom('refund money', 'ask'), 'PUT', '/agents/shop/freedom/refund%20money', { level: 'ask' }],
    ['lessons', (_, shop) => shop.lessons(), 'GET', '/agents/shop/lessons', undefined],
    ['writeLesson', (_, shop) => shop.writeLesson('Offer two times', 'customers asked'), 'POST', '/agents/shop/lessons', { text: 'Offer two times', why: 'customers asked' }],
    ['decide', (_, shop) => shop.decide('ls_1', 'accept'), 'POST', '/agents/shop/lessons/ls_1', { decision: 'accept' }],
    ['versions', (_, shop) => shop.versions(), 'GET', '/agents/shop/versions', undefined],
    ['release', (_, shop) => shop.release(), 'POST', '/agents/shop/versions', {}],
    ['version', (_, shop) => shop.version(3, 'rollback'), 'POST', '/agents/shop/versions/3', { action: 'rollback' }],
    ['tasks', (_, shop) => shop.tasks.list(), 'GET', '/agents/shop/tasks', undefined],
    ['export', (_, shop) => shop.export(since), 'GET', '/agents/shop/export?since=2026-11-01T00%3A00%3A00.000Z', undefined],
    // attack: an id stays in its own segment, never steering the owner's token to another route
    ['removeCaller ../', (_, shop) => shop.removeCaller('../rotate?'), 'DELETE', '/agents/shop/callers/..%2Frotate%3F', undefined],
    ['editFact ../', (_, shop) => shop.editFact('../../x?', 'y'), 'PATCH', '/agents/shop/memory/..%2F..%2Fx%3F', { text: 'y' }],
    ['decide ../', (_, shop) => shop.decide('../x?', 'accept'), 'POST', '/agents/shop/lessons/..%2Fx%3F', { decision: 'accept' }],
  ];
  for (const [what, call, method, path, body] of cases) {
    const ai = fakeAi((request) => (request.path.includes('/export') ? { text: '' } : { body: ANY }));
    const spredr = new Spredr({ token: 'spr_owner', ai: BASE, fetch: ai.fetch });
    await call(spredr, spredr.agent('shop'));
    const [request] = ai.seen;
    assert.equal(request?.method, method, what);
    assert.equal(request?.path, path, what);
    assert.deepEqual(request?.json, body, what);
    assert.equal(request?.headers.authorization, 'Bearer spr_owner', what);
  }
});

test('the export arrives one task per line, steps and all', async () => {
  const ai = fakeAi(() => ({ text: '{"id":"tsk_1","steps":[{"kind":"model"}]}\n{"id":"tsk_2","steps":[]}\n' }));
  const rows = await new Spredr({ token: 't', ai: BASE, fetch: ai.fetch }).agent('shop').export();
  assert.deepEqual(rows.map((row) => [row.id, row.steps.length]), [['tsk_1', 1], ['tsk_2', 0]]);
});
