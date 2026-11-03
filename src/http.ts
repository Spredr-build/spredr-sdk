// Calling ai: signed (an agent or a backend) or with a spredr token (an owner). Errors carry ai's own words.

import type { KeyObject } from 'node:crypto';
import { signedHeaders } from './sign.ts';

export class SpredrError extends Error {
  status: number;
  trace: string;

  constructor(status: number, message: string, trace: string) {
    super(message);
    this.name = 'SpredrError';
    this.status = status;
    this.trace = trace;
  }
}

export type Auth = { token: string } | { from: string; key: KeyObject };

export interface Client {
  call<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
  /** The answer as text (an export, one JSON per line). */
  text(method: 'GET', path: string): Promise<string>;
}

const TIMEOUT_MS = 75_000;

export function client(base: string, auth: Auth, fetcher: typeof fetch = fetch): Client {
  const root = base.replace(/\/+$/, '');
  const headersFor = (method: string, path: string, text: string, json: boolean): Record<string, string> => {
    const headers: Record<string, string> = { accept: json ? 'application/json' : '*/*', ...(text ? { 'content-type': 'application/json' } : {}) };
    if ('token' in auth) headers.authorization = `Bearer ${auth.token}`;
    else Object.assign(headers, signedHeaders(auth.from, auth.key, method, path, text));
    return headers;
  };
  return {
    async text(method, path) {
      const response = await fetcher(`${root}${path}`, { method, headers: headersFor(method, path, '', false), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const raw = await response.text();
      if (!response.ok) throw new SpredrError(response.status, raw.slice(0, 300) || `HTTP ${response.status}`, '');
      return raw;
    },
    async call(method, path, body) {
      const text = body === undefined ? '' : JSON.stringify(body);
      const headers: Record<string, string> = { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
      if ('token' in auth) headers.authorization = `Bearer ${auth.token}`;
      else Object.assign(headers, signedHeaders(auth.from, auth.key, method, path, text));
      const response = await fetcher(`${root}${path}`, { method, headers, ...(body === undefined ? {} : { body: text }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const raw = await response.text();
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!response.ok) {
        const error = typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
        const trace = typeof parsed === 'object' && parsed !== null && 'trace' in parsed && typeof parsed.trace === 'string' ? parsed.trace : '';
        throw new SpredrError(response.status, error, trace);
      }
      // the answer is ai's own JSON: its shape is the type the caller named
      return parsed as never;
    },
  };
}

/** A query string from the values that are set, encoded as it will be signed. */
export function query(values: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(values).filter((pair): pair is [string, string | number] => pair[1] !== undefined).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
}
