// Calling ai: signed (an agent or a backend) or with a spredr token (an owner). Errors carry ai's own words, as the class
// of their case (errors.ts). A request is tried again only when that is safe: no answer came or ai failed, on a method
// that does the same thing twice (GET, PUT, DELETE, or a POST the caller marks idempotent), and a 429 only when ai said
// how long to wait. Each try is signed anew: a signature is good once.

import type { KeyObject } from 'node:crypto';
import { ConnectionError, errorFor, SpredrError, TimeoutError } from './errors.ts';
import { signedHeaders } from './sign.ts';

export { SpredrError } from './errors.ts';

export type Auth = { token: string } | { from: string; key: KeyObject };
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** How every side talks to ai. */
export interface ClientOptions {
  /** A fetch of your own (a proxy, a test). */
  fetch?: typeof fetch;
  /** How long one request may take, in ms: 75 s by default, since a wait for a task is up to 60 s. */
  timeoutMs?: number;
  /** How many more times a request is tried when that is safe: 2 by default; 0 never. */
  maxRetries?: number;
  /** The first wait before trying again, in ms, doubling each time (up to 8 s): 500 by default. */
  retryDelayMs?: number;
}

export interface CallOptions {
  /** Whether sending it twice does the same as once. By default GET, PUT and DELETE do; a POST that carries its own key
   *  says true, a PUT that adds something each time says false. */
  idempotent?: boolean;
}

export interface Client {
  call<T = unknown>(method: Method, path: string, body?: unknown, options?: CallOptions): Promise<T>;
  /** The answer as text (an export, one JSON per line). */
  text(method: 'GET', path: string): Promise<string>;
  /** Bytes sent as they are (a session's file): PUT, signed over those bytes, its own headers beside them. */
  upload<T = unknown>(path: string, data: Uint8Array, headers: Record<string, string>): Promise<T>;
  /** Bytes back as they are, with their type (a session's file). */
  download(path: string): Promise<{ data: Uint8Array; type: string; headers: Headers }>;
  /** Server-sent events from a GET that stays open, one after another, after the event `lastId` (Last-Event-ID). Ends
   *  when the server closes it. */
  events(path: string, lastId: number): AsyncGenerator<{ id: number; event: string; data: string }>;
}

/** How long one stream of events may stay open before it is opened again (the server closes it before that). */
const STREAM_TIMEOUT_MS = 11 * 60_000;

const TIMEOUT_MS = 75_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
/** The longest Retry-After worth waiting for in place; past it, the RateLimitError goes to the caller. */
const MAX_RETRY_AFTER_S = 60;
const REPEATABLE = new Set<Method>(['GET', 'PUT', 'DELETE']);

const fieldOf = (parsed: unknown, name: string): string =>
  typeof parsed === 'object' && parsed !== null && name in parsed && typeof (parsed as Record<string, unknown>)[name] === 'string' ? String((parsed as Record<string, unknown>)[name]) : '';

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: raw ? JSON.parse(raw) : null };
  } catch {
    return { ok: false };
  }
}

function retryAfterOf(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : null;
}

/** The error for an answer that is not ok, whatever its body is (ai's JSON, a proxy's page, nothing). */
async function failureOf(response: Response): Promise<SpredrError> {
  const raw = await response.text();
  const parsed = parseJson(raw);
  const message = (parsed.ok ? fieldOf(parsed.value, 'error') : '') || raw.slice(0, 300).trim() || `HTTP ${response.status}`;
  return errorFor(response.status, message, parsed.ok ? fieldOf(parsed.value, 'trace') : '', retryAfterOf(response));
}

export function client(base: string, auth: Auth, options: ClientOptions = {}): Client {
  const root = base.replace(/\/+$/, '');
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxRetries = Math.max(0, options.maxRetries ?? MAX_RETRIES);
  const firstDelay = options.retryDelayMs ?? RETRY_DELAY_MS;

  const headersFor = (method: Method, path: string, text: string | Uint8Array, json: boolean): Record<string, string> => {
    const headers: Record<string, string> = { accept: json ? 'application/json' : '*/*', ...(typeof text === 'string' && text ? { 'content-type': 'application/json' } : {}) };
    if ('token' in auth) headers.authorization = `Bearer ${auth.token}`;
    else Object.assign(headers, signedHeaders(auth.from, auth.key, method, path, text));
    return headers;
  };

  const waitBefore = (tryNumber: number, retryAfter: number | null): Promise<void> => {
    const backoff = Math.min(MAX_DELAY_MS, firstDelay * 2 ** tryNumber) * (0.75 + Math.random() * 0.5);
    return new Promise((resolve) => setTimeout(resolve, retryAfter === null ? backoff : retryAfter * 1000));
  };

  /** Sends until there is an answer worth giving back: ok, or a failure that trying again would not change. */
  async function send(method: Method, path: string, text: string | Uint8Array, json: boolean, repeatable: boolean, extra: Record<string, string> = {}, waitMs = timeoutMs): Promise<Response> {
    for (let tryNumber = 0; ; tryNumber++) {
      const last = tryNumber >= maxRetries;
      let response: Response;
      try {
        response = await fetcher(`${root}${path}`, { method, headers: { ...headersFor(method, path, text, json), ...extra }, ...(text.length ? { body: typeof text === 'string' ? text : new Uint8Array(text) } : {}), signal: AbortSignal.timeout(waitMs) });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        if (!repeatable || last) {
          throw timedOut ? new TimeoutError(0, `ai did not answer in ${timeoutMs} ms (${method} ${path}).`) : new ConnectionError(0, `ai could not be reached (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`);
        }
        await waitBefore(tryNumber, null);
        continue;
      }
      if (response.ok || last) return response;
      const retryAfter = retryAfterOf(response);
      const again = response.status === 429 ? retryAfter !== null && retryAfter <= MAX_RETRY_AFTER_S : repeatable && (response.status === 408 || response.status >= 500);
      if (!again) return response;
      await response.body?.cancel();
      await waitBefore(tryNumber, retryAfter);
    }
  }

  return {
    async text(method, path) {
      const response = await send(method, path, '', false, true);
      if (!response.ok) throw await failureOf(response);
      return response.text();
    },
    async call(method, path, body, callOptions = {}) {
      const text = body === undefined ? '' : JSON.stringify(body);
      const response = await send(method, path, text, true, callOptions.idempotent ?? REPEATABLE.has(method));
      if (!response.ok) throw await failureOf(response);
      const parsed = parseJson(await response.text());
      if (!parsed.ok) throw new SpredrError(response.status, `ai answered ${method} ${path} with something that is not JSON.`);
      // the answer is ai's own JSON: its shape is the type the caller named
      return parsed.value as never;
    },
    async upload(path, data, headers) {
      // a PUT by name: sending it twice leaves the same file
      const response = await send('PUT', path, data, true, true, { 'content-type': 'application/octet-stream', ...headers });
      if (!response.ok) throw await failureOf(response);
      const parsed = parseJson(await response.text());
      if (!parsed.ok) throw new SpredrError(response.status, `ai answered PUT ${path} with something that is not JSON.`);
      return parsed.value as never;
    },
    async *events(path, lastId) {
      const response = await send('GET', path, '', false, true, { accept: 'text/event-stream', ...(lastId ? { 'last-event-id': String(lastId) } : {}) }, STREAM_TIMEOUT_MS);
      if (!response.ok) throw await failureOf(response);
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        // one event per blank line: its id, its name and its data; a line starting with «:» only keeps it open
        for (let end = buffered.indexOf('\n\n'); end >= 0; end = buffered.indexOf('\n\n')) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const field = (name: string) => block.split('\n').filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1).trimStart()).join('\n');
          const data = field('data');
          if (data) yield { id: Number(field('id')) || 0, event: field('event') || 'message', data };
        }
      }
    },
    async download(path) {
      const response = await send('GET', path, '', false, true);
      if (!response.ok) throw await failureOf(response);
      return { data: new Uint8Array(await response.arrayBuffer()), type: response.headers.get('content-type') ?? 'application/octet-stream', headers: response.headers };
    },
  };
}

/** A query string from the values that are set, encoded as it will be signed. */
export function query(values: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(values).filter((pair): pair is [string, string | number] => pair[1] !== undefined).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
}
