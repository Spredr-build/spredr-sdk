// The HTTP client every side shares: where it calls, how it signs or carries the token, and how ai's errors arrive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, query, SpredrError } from '../src/http.ts';
import { AI_SIGNER, aiVerifier, privateKeyOf } from '../src/sign.ts';
import { newKeys } from '../src/index.ts';
import { BASE, fakeAi } from './helpers.ts';

test('a token goes as a bearer, JSON goes with its type, and the base keeps its path whatever slashes it ends with', async () => {
  const ai = fakeAi(() => ({ body: { ok: true } }));
  const answer = await client(`${BASE}//`, { token: 'spr_x' }, { fetch: ai.fetch }).call('POST', '/agents', { name: 'shop' });
  assert.deepEqual(answer, { ok: true });
  const [request] = ai.seen;
  assert.equal(request?.path, '/agents');
  assert.equal(request?.headers.authorization, 'Bearer spr_x');
  assert.equal(request?.headers['content-type'], 'application/json');
  assert.deepEqual(request?.json, { name: 'shop' });
});

test('a signed request is one ai can check: method, path with its query, time, nonce and body', async () => {
  const keys = newKeys();
  const ai = fakeAi();
  await client(BASE, { from: AI_SIGNER, key: privateKeyOf(keys.privateKey) }, { fetch: ai.fetch }).call('PUT', '/agent/memory?x=1', { text: 'hola' });
  const [request] = ai.seen;
  assert.ok(request);
  const check = aiVerifier(keys.publicKey);
  assert.equal(check({ method: 'PUT', path: '/agent/memory?x=1', headers: request.headers, body: request.body }), true);
  assert.equal(aiVerifier(keys.publicKey)({ method: 'PUT', path: '/agent/memory?x=2', headers: request.headers, body: request.body }), false, 'another query');
  assert.equal(aiVerifier(keys.publicKey)({ method: 'PUT', path: '/agent/memory?x=1', headers: request.headers, body: '{"text":"adios"}' }), false, 'another body');
});

test('ai\'s refusal arrives as a SpredrError with its status, its words and its trace', async () => {
  const ai = fakeAi(() => ({ status: 429, body: { error: 'shop reached its spend for today', trace: 'tr_1' } }));
  await assert.rejects(client(BASE, { token: 't' }, { fetch: ai.fetch }).call('POST', '/agents/shop/tasks', {}), (error: unknown) =>
    error instanceof SpredrError && error.status === 429 && error.message === 'shop reached its spend for today' && error.trace === 'tr_1');
});

test('an answer as text (the export) comes back as it is; its failure is a SpredrError too', async () => {
  const lines = '{"id":"a"}\n{"id":"b"}\n';
  assert.equal(await client(BASE, { token: 't' }, { fetch: fakeAi(() => ({ text: lines })).fetch }).text('GET', '/agents/shop/export'), lines);
  await assert.rejects(client(BASE, { token: 't' }, { fetch: fakeAi(() => ({ status: 404, text: 'There is no agent named shop.' })).fetch }).text('GET', '/x'),
    (error: unknown) => error instanceof SpredrError && error.status === 404 && /no agent named shop/.test(error.message));
});

test('a query takes only the values that are set, encoded as they will be signed', () => {
  assert.equal(query({ scope: 'customer:ana maría', limit: 5, q: undefined }), '?scope=customer%3Aana%20mar%C3%ADa&limit=5');
  assert.equal(query({ q: undefined }), '');
});
