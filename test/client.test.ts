// The SDK on its own, with no ai behind it: where it calls, with which token, and which callbacks it believes. The SDK
// against the real ai (a task, a question, memory, a lesson, an export) is tested in spredr's api, where ai lives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_SIGNER, privateKeyOf, signedHeaders } from '../src/sign.ts';
import { Caller, newKeys, Spredr } from '../src/index.ts';

const TOKEN = 'spr_test';

test('by default an owner reaches ai under api.spredr.cloud/ai with SPREDR_TOKEN, and a base with a path keeps it on every call', async () => {
  const asked: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const before = { url: process.env.SPREDR_AI_URL, token: process.env.SPREDR_TOKEN };
  try {
    process.env.SPREDR_AI_URL = '';
    await new Spredr({ token: TOKEN, fetch: fetcher }).agents();
    await new Spredr({ token: TOKEN, ai: 'https://api.spredr.cloud/ai/', fetch: fetcher }).agents();
    delete process.env.SPREDR_TOKEN;
    assert.throws(() => new Spredr({ fetch: fetcher }), /SPREDR_TOKEN is not set/, 'no token: said at once, not as a 401 later');
    process.env.SPREDR_TOKEN = TOKEN;
    await new Spredr({ fetch: fetcher }).agents();
  } finally {
    for (const [name, value] of [['SPREDR_AI_URL', before.url], ['SPREDR_TOKEN', before.token]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.deepEqual(asked, ['https://api.spredr.cloud/ai/agents', 'https://api.spredr.cloud/ai/agents', 'https://api.spredr.cloud/ai/agents'],
    'the same host as the panel\'s session; an empty SPREDR_AI_URL, as a .env leaves it, is no address');
});

test('a backend believes a callback only when ai signed it, recently, once, and with that very body', () => {
  const ai = newKeys();
  const mine = newKeys();
  const backend = new Caller({ id: 'cl_test', key: mine.privateKey, agent: 'shop', ai: 'https://api.spredr.cloud/ai', aiKey: ai.publicKey });
  const body = JSON.stringify({ event: 'task.done', task: { id: 'tsk_1', status: 'done' } });
  const signed = (from: string, key: string, text: string) => ({ method: 'POST', path: '/spredr/callback', headers: signedHeaders(from, privateKeyOf(key), 'POST', '/spredr/callback', text), body: text });

  const real = signed(AI_SIGNER, ai.privateKey, body);
  assert.equal(backend.callback(real)?.event, 'task.done');
  assert.equal(backend.callback(real), null, 'the same callback twice: a replay');
  assert.equal(backend.callback({ ...signed(AI_SIGNER, ai.privateKey, body), body: body.replace('done', 'failed') }), null, 'a body changed after signing');
  assert.equal(backend.callback(signed(AI_SIGNER, mine.privateKey, body)), null, 'signed with any other key');
  assert.equal(backend.callback(signed('cl_other', ai.privateKey, body)), null, 'signed as anyone but ai');
  assert.throws(() => new Caller({ id: 'cl_test', key: mine.privateKey, agent: 'shop', ai: 'https://api.spredr.cloud/ai' }).callback(real), /SPREDR_AI_KEY/, 'without ai\'s key it cannot tell, so it says so');
});
