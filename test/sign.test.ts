// The signature between ai, agents and backends: what passes, and every way a request is turned away.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_SIGNER, aiVerifier, HEADERS, privateKeyOf, signedHeaders } from '../src/sign.ts';
import { newKeys } from '../src/index.ts';

const ai = newKeys();
const signed = (body = '{"a":1}', path = '/spredr/task', from = AI_SIGNER, key = ai.privateKey) =>
  ({ method: 'POST', path, headers: signedHeaders(from, privateKeyOf(key), 'POST', path, body), body });

test('newKeys gives an ed25519 pair, each side keeping only the other\'s public half', () => {
  const pair = newKeys();
  assert.match(pair.publicKey, /^[A-Za-z0-9+/]+=*$/);
  assert.notEqual(pair.privateKey, pair.publicKey);
  assert.ok(aiVerifier(pair.publicKey));
});

test('a request ai signed passes once; the same one again is a replay', () => {
  const check = aiVerifier(ai.publicKey);
  const request = signed();
  assert.equal(check(request), true);
  assert.equal(check(request), false);
});

test('a body given as bytes is checked the same as text', () => {
  const request = signed('{"ñ":"sí"}');
  assert.equal(aiVerifier(ai.publicKey)({ ...request, body: new TextEncoder().encode(request.body) }), true);
});

test('turned away: another body, another path, another method, another key, another signer, no signature', () => {
  const cases: [string, (request: ReturnType<typeof signed>) => object][] = [
    ['body', (request) => ({ ...request, body: '{"a":2}' })],
    ['path', (request) => ({ ...request, path: '/other' })],
    ['method', (request) => ({ ...request, method: 'PUT' })],
    ['signature', (request) => ({ ...request, headers: { ...request.headers, [HEADERS.signature]: '' } })],
    ['nonce', (request) => ({ ...request, headers: { ...request.headers, [HEADERS.nonce]: 'not-a-nonce' } })],
  ];
  for (const [what, change] of cases) {
    const check = aiVerifier(ai.publicKey);
    assert.equal(check(change(signed()) as Parameters<typeof check>[0]), false, what);
  }
  assert.equal(aiVerifier(ai.publicKey)(signed('{}', '/spredr/task', AI_SIGNER, newKeys().privateKey)), false, 'another key');
  assert.equal(aiVerifier(ai.publicKey)(signed('{}', '/spredr/task', 'ag_someone')), false, 'signed as someone but ai');
});

test('a signature from more than five minutes ago, or from the future, is turned away', () => {
  for (const offset of [-6 * 60_000, 6 * 60_000]) {
    const request = signed();
    const moved = { ...request, headers: { ...request.headers, [HEADERS.time]: new Date(Date.now() + offset).toISOString() } };
    assert.equal(aiVerifier(ai.publicKey)(moved), false, `${offset / 60_000} minutes`);
  }
});
