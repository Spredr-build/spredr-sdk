// A fake ai for the SDK's own tests: a fetch that keeps every request (method, path, headers, body) and answers what
// each test says, and a way to hand a running Agent a task signed by ai's real key. No network beyond localhost.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { AI_SIGNER, privateKeyOf, signedHeaders } from '../src/sign.ts';
import { newKeys } from '../src/index.ts';

export const BASE = 'https://api.spredr.cloud/ai';

export interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  json: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  /** Sent as it is, not as JSON (an export, a proxy's error page). */
  text?: string;
  headers?: Record<string, string>;
}

export type Route = (request: Seen) => Reply | undefined;

/** A fetch answering from `route` (200 {} when it says nothing), and every request it saw. */
export function fakeAi(route: Route = () => undefined) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const body = typeof init?.body === 'string' ? init.body : '';
    const request: Seen = { method: init?.method ?? 'GET', path: url.pathname.replace(/^\/ai/, '') + url.search, headers, body, json: body ? JSON.parse(body) : undefined };
    seen.push(request);
    const reply = route(request) ?? {};
    const text = reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status ?? 200, headers: { 'content-type': reply.text === undefined ? 'application/json' : 'text/plain', ...reply.headers } });
  };
  return { fetch, seen, last: (path: string) => [...seen].reverse().find((one) => one.path === path) };
}

/** The keys a test plays ai and an agent with, as spredr writes them into the agent's variables. */
export function agentKeys() {
  const ai = newKeys();
  const agent = newKeys();
  return { ai, agent, options: { id: 'ag_test', key: agent.privateKey, ai: BASE, aiKey: ai.publicKey } };
}

/** Hands the agent listening on `server` one task, signed by ai. */
export async function deliver(server: Server, aiPrivateKey: string, delivery: object, signer = AI_SIGNER): Promise<Response> {
  const body = JSON.stringify(delivery);
  const { port } = server.address() as AddressInfo;
  return globalThis.fetch(`http://127.0.0.1:${port}/spredr/task`, { method: 'POST', headers: { 'content-type': 'application/json', ...signedHeaders(signer, privateKeyOf(aiPrivateKey), 'POST', '/spredr/task', body) }, body });
}

/** A delivery as ai sends it. */
export function delivery(kind: string, input: unknown, extra: { id?: string; resume?: object | null; lessons?: string[]; trial?: boolean } = {}) {
  return {
    task: { id: extra.id ?? 'tsk_1', kind, input, attempt: 1, by: 'caller', trial: extra.trial ?? false, judges: null, createdAt: new Date().toISOString() },
    resume: extra.resume ?? null,
    lessons: { version: 1, items: extra.lessons ?? [] },
  };
}

/** Waits until `check` holds (the agent works after it answered 202). */
export async function until<T>(check: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
