// ctx.delegate: a part of the task handed to another of the owner's agents. Asked once per key (the same call in the
// same place keeps its key every run), past the parallel cap it waits its turn, it waits while the part works, and it
// gives back the part's result or a PartError.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, PartError, PermissionDeniedError, type Handler } from '../src/index.ts';
import { agentKeys, deliver, delivery, fakeAi, until, type Route } from './helpers.ts';

async function running(t: TestContext, handlers: Record<string, Handler>, route?: Route) {
  const keys = agentKeys();
  const ai = fakeAi(route);
  const agent = new Agent({ ...keys.options, fetch: ai.fetch });
  for (const [kind, handler] of Object.entries(handlers)) agent.on(kind, handler);
  const server = await agent.listen(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { ai, give: (body: object) => deliver(server, keys.ai.privateKey, body) };
}

const resultOf = (ai: ReturnType<typeof fakeAi>) => until(() => ai.last('/agent/tasks/tsk_1/result')?.json as { attempt: number; result?: unknown; error?: string } | undefined, 8_000);

test('two parts at once: each asked with its own key, the second waits its turn, both come back', async (t) => {
  let refused = 0;
  const polls = new Map<string, number>();
  const { ai, give } = await running(t, {
    article: async (_, ctx) => {
      const [sources, prices] = await Promise.all([
        ctx.delegate<{ n: number }>('investiga', 'sources', { topic: 'café' }, { title: 'Fuentes' }),
        ctx.delegate<{ n: number }>('investiga', 'sources', { topic: 'precios' }),
      ]);
      return { sources: sources.n, prices: prices.n };
    },
  }, (request) => {
    if (request.method === 'POST' && request.path === '/agent/tasks/tsk_1/parts') {
      const key = (request.json as { key: string }).key;
      // the owner's cap is one at once: the second is refused once and asks again
      if (key.endsWith('.2') && refused === 0) { refused += 1; return { status: 429, body: { error: 'one at once' } }; }
      return { status: 201, body: { part: { id: `tsk_${key}`, agent: 'investiga', kind: 'sources', status: 'queued', result: null, error: '' } } };
    }
    const asked = /^\/agent\/tasks\/tsk_1\/parts\/([^?]+)\?/.exec(request.path);
    if (asked) {
      const id = asked[1] ?? '';
      const seen = (polls.get(id) ?? 0) + 1;
      polls.set(id, seen);
      return { body: { part: { id, agent: 'investiga', kind: 'sources', status: seen < 2 ? 'running' : 'done', result: seen < 2 ? null : { n: id.endsWith('.1') ? 3 : 5 }, error: '' } } };
    }
    return undefined;
  });
  await give(delivery('article', {}));
  assert.deepEqual(await resultOf(ai), { attempt: 1, result: { sources: 3, prices: 5 } });
  const asks = ai.seen.filter((one) => one.method === 'POST' && one.path === '/agent/tasks/tsk_1/parts').map((one) => one.json as { key: string; attempt: number; agent: string; title?: string });
  assert.deepEqual(asks.map((one) => one.key), ['investiga.sources.1', 'investiga.sources.2', 'investiga.sources.2'], 'the same key each try, a key per part');
  assert.equal(asks[0]?.title, 'Fuentes');
  assert.ok(asks.every((one) => one.attempt === 1 && one.agent === 'investiga'));
  const waits = ai.seen.filter((one) => one.path.startsWith('/agent/tasks/tsk_1/parts/'));
  assert.ok(waits.every((one) => one.path.includes('attempt=1') && one.path.includes('wait=25')), 'each wait names the attempt (it keeps the task\'s place) and holds on ai');
});

test('a part that failed is a PartError the handler can catch; a trial asks nobody', async (t) => {
  let caught: unknown;
  const { ai, give } = await running(t, {
    article: async (_, ctx) => {
      try { await ctx.delegate('revisa', 'review', { text: 'hola' }); } catch (error) { caught = error; }
      return 'without review';
    },
  }, (request) => {
    if (request.method === 'POST' && request.path === '/agent/tasks/tsk_1/parts') return { status: 201, body: { part: { id: 'tsk_p', agent: 'revisa', kind: 'review', status: 'failed', result: null, error: 'the model said no' } } };
    return undefined;
  });
  await give(delivery('article', {}));
  assert.deepEqual(await resultOf(ai), { attempt: 1, result: 'without review' });
  assert.ok(caught instanceof PartError);
  assert.equal(caught.agent, 'revisa');
  assert.equal(caught.status, 'failed');
  assert.match(caught.message, /revisa could not do its part: the model said no/);

  const trial = await running(t, { article: async (_, ctx) => ctx.delegate('revisa', 'review') });
  await trial.give(delivery('article', {}, { trial: true }));
  const outcome = await until(() => trial.ai.last('/agent/tasks/tsk_1/result')?.json as { error?: string } | undefined);
  assert.match(outcome.error ?? '', /A trial does nothing real/);
  assert.equal(trial.ai.seen.filter((one) => one.path.includes('/parts')).length, 0);
});

test('a part waiting for a person is asked less often and still comes back; your own key is the key; a refusal is thrown as it is', async (t) => {
  let polls = 0;
  let refused: unknown;
  const { ai, give } = await running(t, {
    article: async (_, ctx) => {
      const review = await ctx.delegate<string>('revisa', 'review', { text: 'hola' }, { key: 'la revisión del texto' });
      try { await ctx.delegate('nadie', 'x'); } catch (error) { refused = error; }
      return review;
    },
  }, (request) => {
    if (request.method === 'POST' && request.path === '/agent/tasks/tsk_1/parts') {
      const body = request.json as { agent: string; key: string };
      if (body.agent === 'nadie') return { status: 403, body: { error: 'storio may not ask nadie for parts' } };
      return { status: 201, body: { part: { id: 'tsk_r', agent: 'revisa', kind: 'review', status: 'paused', result: null, error: '' } } };
    }
    if (request.path.startsWith('/agent/tasks/tsk_1/parts/tsk_r')) {
      polls += 1;
      return { body: { part: { id: 'tsk_r', agent: 'revisa', kind: 'review', status: polls < 2 ? 'paused' : 'done', result: polls < 2 ? null : 'aprobado', error: '' } } };
    }
    return undefined;
  });
  await give(delivery('article', {}));
  // a paused part is asked every 5 s: two asks here
  assert.deepEqual(await until(() => ai.last('/agent/tasks/tsk_1/result')?.json as { attempt: number; result?: unknown } | undefined, 15_000), { attempt: 1, result: 'aprobado' });
  const asks = ai.seen.filter((one) => one.method === 'POST' && one.path === '/agent/tasks/tsk_1/parts').map((one) => (one.json as { key: string }).key);
  assert.equal(asks[0], 'la-revisi-n-del-texto', 'your key, only with what a key may hold');
  const waits = ai.seen.filter((one) => one.path.startsWith('/agent/tasks/tsk_1/parts/tsk_r'));
  assert.ok(waits.every((one) => one.path.includes('wait=0')), 'a paused part is not held on ai: it waits between asks');
  assert.ok(refused instanceof PermissionDeniedError, 'a 403 is the handler\'s to catch, never retried');
  assert.equal(asks.filter((key) => key.startsWith('nadie')).length, 1);
});
