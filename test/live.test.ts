// A task as it happens (stream, live) and the files around a session (attach, files, detach; an owner's stored files),
// against an ai that answers the way the real one does: server-sent events that may close before the end, uploads by
// name, downloads with their type.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Caller, Spredr, SpredrError, newKeys, type StreamEvent } from '../src/index.ts';
import { BASE, fakeAi, type Route } from './helpers.ts';

const mine = newKeys();
const SSE = { 'content-type': 'text/event-stream' };
const sse = (...events: [number, string, object][]): string => `: still working\n\n${events.map(([id, name, data]) => `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')}`;
const caller = (route: Route) => {
  const ai = fakeAi(route);
  return { ai, shop: new Caller({ id: 'cl_shop', key: mine.privateKey, agent: 'shop', ai: BASE, fetch: ai.fetch }) };
};
const all = async (events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> => { const got: StreamEvent[] = []; for await (const event of events) got.push(event); return got; };

test('a stream gives the live pieces, the other events and the task last; one that closes early goes on after what it saw', async () => {
  let opened = 0;
  const { ai, shop } = caller((request) => {
    if (!request.path.startsWith('/tasks/tsk_1/stream')) return undefined;
    opened += 1;
    return opened === 1
      ? { headers: SSE, text: sse([1, 'delta', { seq: 1, type: 'delta', data: { text: 'Hola, ' } }], [2, 'progress', { seq: 2, type: 'progress', data: { step: 'catalog' } }]) }
      : { headers: SSE, text: sse([3, 'delta', { seq: 3, type: 'delta', data: { text: 'Ana' } }], [0, 'task', { id: 'tsk_1', status: 'done', result: 'Hola, Ana' }]) };
  });
  const got = await all(shop.stream('tsk_1'));
  assert.deepEqual(got.map((event) => event.type), ['delta', 'event', 'delta', 'end']);
  assert.deepEqual(got.filter((event) => event.type === 'delta').map((event) => event.text), ['Hola, ', 'Ana']);
  const last = got.at(-1);
  assert.equal(last?.type === 'end' ? last.task.status : '', 'done');
  const reopened = ai.seen.filter((request) => request.path.startsWith('/tasks/tsk_1/stream'));
  assert.equal(reopened.length, 2, 'opened again when it closed before the task');
  assert.equal(reopened[1]?.headers['last-event-id'], '2', 'after the last event it saw: nothing comes twice');
});

test('live asks for the task and streams it; a stream ai refuses is said as an error', async () => {
  const { ai, shop } = caller((request) => {
    if (request.path === '/agents/shop/tasks') return { status: 202, body: { task: { id: 'tsk_7', status: 'queued' }, created: true } };
    if (request.path.startsWith('/tasks/tsk_7/stream')) return { headers: SSE, text: sse([0, 'task', { id: 'tsk_7', status: 'done', result: 42 }]) };
    if (request.path.startsWith('/tasks/tsk_8/stream')) return { status: 429, body: { error: 'You are already watching 50 tasks at once.' } };
    return undefined;
  });
  const got = await all(shop.live('reply', { text: 'hola' }));
  assert.deepEqual(got, [{ type: 'end', task: { id: 'tsk_7', status: 'done', result: 42 } }]);
  assert.equal(Reflect.get(Object(ai.seen[0]?.json), 'kind'), 'reply');
  await assert.rejects(all(shop.stream('tsk_8')), (error: unknown) => error instanceof SpredrError && error.status === 429);
});

test('files go into a session by name, are listed and taken out, each with its tenant; a non-JSON answer is an error', async () => {
  const { ai, shop } = caller((request) => {
    if (request.method === 'PUT' && request.path.includes('file=broken')) return { text: '<html>proxy</html>' };
    if (request.method === 'PUT') return { body: { file: { id: 'fil_1', name: 'prices.csv' } } };
    if (request.method === 'GET') return { body: { files: [{ id: 'fil_1', name: 'prices.csv' }] } };
    return { body: {} };
  });
  const kept = await shop.attach('customer:ana', 'prices.csv', 'sku,price\n1,10', { tenant: 'shop-12' });
  assert.equal(kept.id, 'fil_1');
  const put = ai.seen[0];
  assert.equal(put?.path, '/agents/shop/files?thread=customer%3Aana&file=prices.csv&tenant=shop-12');
  assert.equal(put?.headers['x-spredr-file-type'], 'text/plain', 'text is said to be text');
  assert.equal(put?.headers['content-type'], 'application/octet-stream', 'the bytes travel as they are');
  await shop.attach('customer:ana', 'photo.bin', new Uint8Array([1, 2, 3]));
  assert.equal(ai.seen[1]?.headers['x-spredr-file-type'], 'application/octet-stream');
  assert.deepEqual((await shop.files('customer:ana')).map((file) => file.name), ['prices.csv']);
  assert.equal(ai.seen[2]?.path, '/agents/shop/files?thread=customer%3Aana');
  await shop.detach('customer:ana', 'prices.csv', { tenant: 'shop-12' });
  assert.equal(ai.seen[3]?.method, 'DELETE');
  assert.equal(ai.seen[3]?.path, '/agents/shop/files?thread=customer%3Aana&file=prices.csv&tenant=shop-12');
  await assert.rejects(shop.attach('t', 'broken', 'x'), /not JSON/);
});

test('an owner lists, downloads and deletes the files its agent keeps, any session\'s', async () => {
  const ai = fakeAi((request) => {
    if (request.path === '/agents/shop/stored-files/fil_9' && request.method === 'GET') return { text: 'sku,price', headers: { 'content-type': 'text/csv' } };
    if (request.path === '/agents/shop/stored-files/fil_404') return { status: 404, body: { error: 'No such file.' } };
    if (request.path.startsWith('/agents/shop/stored-files')) return { body: { files: [{ id: 'fil_9', name: 'prices.csv' }], usedBytes: 9, maxBytes: 100, filesBytes: 9, memoryBytes: 0 } };
    return { body: {} };
  });
  const spredr = new Spredr({ token: 'spr_owner', ai: BASE, fetch: ai.fetch });
  const shop = spredr.agent('shop');
  const stored = await shop.storedFiles({ limit: 10 });
  assert.equal(stored.files[0]?.id, 'fil_9');
  assert.equal(ai.seen[0]?.path, '/agents/shop/stored-files?limit=10');
  const file = await shop.downloadFile('fil_9');
  assert.equal(new TextDecoder().decode(file.data), 'sku,price');
  assert.equal(file.type, 'text/csv');
  await assert.rejects(shop.downloadFile('fil_404'), (error: unknown) => error instanceof SpredrError && error.status === 404);
  await shop.deleteFile('fil_9');
  assert.equal(ai.seen.at(-1)?.method, 'DELETE');
  assert.equal(ai.seen.at(-1)?.headers.authorization, 'Bearer spr_owner');
});
