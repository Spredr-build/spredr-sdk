// Errors by case, and trying again only when that is safe: never a second POST that would do something twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthenticationError, BadRequestError, Caller, ConflictError, ConnectionError, InternalServerError, newKeys, NotFoundError, PermissionDeniedError,
  RateLimitError, Spredr, SpredrError, TimeoutError,
} from '../src/index.ts';
import { client } from '../src/http.ts';
import { BASE, fakeAi, type Reply } from './helpers.ts';

const FAST = { retryDelayMs: 1 };
/** Answers each request with the next reply, the last one from then on. */
const inTurn = (...replies: Reply[]) => () => (replies.length > 1 ? replies.shift() : replies[0]);

test('each status arrives as its own class, every one a SpredrError', async () => {
  const cases: [number, Function][] = [[400, BadRequestError], [401, AuthenticationError], [403, PermissionDeniedError], [404, NotFoundError], [409, ConflictError], [429, RateLimitError], [500, InternalServerError], [503, InternalServerError], [418, SpredrError]];
  for (const [status, Class] of cases) {
    const ai = fakeAi(() => ({ status, body: { error: `it was ${status}` } }));
    const error = await new Spredr({ token: 't', ai: BASE, fetch: ai.fetch, maxRetries: 0 }).agents().catch((caught: unknown) => caught);
    assert.ok(error instanceof Class, `${status}`);
    assert.ok(error instanceof SpredrError, `${status} is a SpredrError`);
    assert.equal((error as SpredrError).message, `it was ${status}`);
    assert.equal((error as SpredrError).name, Class.name);
  }
});

test('a page that is not JSON (a proxy that fell over) is still a spredr error, with its words', async () => {
  const ai = fakeAi(() => ({ status: 502, text: '<html>Bad gateway</html>' }));
  await assert.rejects(new Spredr({ token: 't', ai: BASE, fetch: ai.fetch, ...FAST }).agents(), (error: unknown) => error instanceof InternalServerError && error.status === 502 && /Bad gateway/.test(error.message));
  await assert.rejects(new Spredr({ token: 't', ai: BASE, fetch: fakeAi(() => ({ text: 'not json' })).fetch }).agents(), (error: unknown) => error instanceof SpredrError && /not JSON/.test(error.message));
});

test('a read that fails on ai\'s side is tried again, signed anew each time', async () => {
  const ai = fakeAi(inTurn({ status: 503 }, { status: 502 }, { body: { pauses: [{ id: 'pz_1' }] } }));
  const shop = new Caller({ id: 'cl_shop', key: newKeys().privateKey, agent: 'shop', ai: BASE, fetch: ai.fetch, ...FAST });
  assert.deepEqual(await shop.pauses(), [{ id: 'pz_1' }]);
  assert.equal(ai.seen.length, 3);
  assert.equal(new Set(ai.seen.map((one) => one.headers['x-spredr-nonce'])).size, 3, 'a signature is good once');
});

test('a POST that would do something twice is never sent again; one with its own key is', async () => {
  const shop = (fetch: typeof globalThis.fetch) => new Caller({ id: 'cl_shop', key: newKeys().privateKey, agent: 'shop', ai: BASE, fetch, ...FAST });
  const once = fakeAi(() => ({ status: 503 }));
  await assert.rejects(shop(once.fetch).ask('reply', 'hola'), InternalServerError);
  assert.equal(once.seen.length, 1, 'no key: a second POST could make a second task');
  const keyed = fakeAi(inTurn({ status: 503 }, { body: { task: { id: 'tsk_1', status: 'queued' } } }));
  assert.equal((await shop(keyed.fetch).ask('reply', 'hola', { key: 'msg-1' })).id, 'tsk_1');
  assert.equal(keyed.seen.length, 2, 'with a key, asking again is the same task');
});

test('a 429 is tried again only when ai says how long to wait; a cap reached goes straight back', async () => {
  const capped = fakeAi(() => ({ status: 429, body: { error: 'the month\'s tasks are used' } }));
  await assert.rejects(new Spredr({ token: 't', ai: BASE, fetch: capped.fetch, ...FAST }).agents(), (error: unknown) => error instanceof RateLimitError && error.retryAfter === null);
  assert.equal(capped.seen.length, 1);
  const slowed = fakeAi(inTurn({ status: 429, headers: { 'retry-after': '0' } }, { body: { agents: [] } }));
  assert.deepEqual(await new Spredr({ token: 't', ai: BASE, fetch: slowed.fetch, ...FAST }).agents(), []);
  assert.equal(slowed.seen.length, 2);
});

test('maxRetries 0 sends once; past the retries the last answer is the error', async () => {
  const ai = fakeAi(() => ({ status: 503 }));
  await assert.rejects(new Spredr({ token: 't', ai: BASE, fetch: ai.fetch, maxRetries: 0 }).agents(), InternalServerError);
  assert.equal(ai.seen.length, 1);
  const thrice = fakeAi(() => ({ status: 503 }));
  await assert.rejects(new Spredr({ token: 't', ai: BASE, fetch: thrice.fetch, maxRetries: 2, ...FAST }).agents(), InternalServerError);
  assert.equal(thrice.seen.length, 3);
});

test('no answer at all is a ConnectionError, tried again only when that is safe', async () => {
  let tries = 0;
  const down: typeof globalThis.fetch = async () => { tries += 1; throw new TypeError('fetch failed'); };
  await assert.rejects(new Spredr({ token: 't', ai: BASE, fetch: down, ...FAST }).agents(), (error: unknown) => error instanceof ConnectionError && error.status === 0 && /fetch failed/.test(error.message));
  assert.equal(tries, 3);
  tries = 0;
  await assert.rejects(new Spredr({ token: 't', ai: BASE, fetch: down, ...FAST }).agent('shop').release(), ConnectionError);
  assert.equal(tries, 1, 'a POST that may have arrived is not sent again');
});

test('an answer that does not come in time is a TimeoutError', async () => {
  const hangs: typeof globalThis.fetch = (_, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
  await assert.rejects(new Spredr({ token: 't', ai: BASE, fetch: hangs, timeoutMs: 20, maxRetries: 0 }).agents(), (error: unknown) => error instanceof TimeoutError && error instanceof ConnectionError);
});

test('a fact without a key is written once, even when ai fails: sent twice it would be two', async () => {
  const keys = newKeys();
  const ai = fakeAi(() => ({ status: 503 }));
  const signed = client(BASE, { from: 'ag_test', key: (await import('../src/sign.ts')).privateKeyOf(keys.privateKey) }, { fetch: ai.fetch, ...FAST });
  await assert.rejects(signed.call('PUT', '/agent/memory', { scope: 'customer:ana', text: 'x' }, { idempotent: false }), InternalServerError);
  assert.equal(ai.seen.length, 1);
  await assert.rejects(signed.call('PUT', '/agent/memory', { scope: 'customer:ana', text: 'x', key: 'last' }), InternalServerError);
  assert.equal(ai.seen.length, 4, 'with a key it replaces, so it is tried again');
});
