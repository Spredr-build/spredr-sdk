// What can go wrong talking to ai, one class per case, all of them a SpredrError: catch the base, or the one case you
// handle (a RateLimitError to slow down, a NotFoundError for a name that is gone). A task that ends badly is a TaskError.

import type { Task } from './types.ts';

export class SpredrError extends Error {
  /** The HTTP status ai answered with; 0 when no answer came. */
  readonly status: number;
  /** ai's trace id for this request, to quote when you write to spredr. */
  readonly trace: string;

  constructor(status: number, message: string, trace = '') {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.trace = trace;
  }
}

/** 400: what was sent is not right; the message says what. */
export class BadRequestError extends SpredrError {}
/** 401: no token, a wrong one, or a signature ai does not believe. */
export class AuthenticationError extends SpredrError {}
/** 403: allowed to ask, not this (a plan's limit, another owner's agent). */
export class PermissionDeniedError extends SpredrError {}
/** 404: no such agent, task or question. */
export class NotFoundError extends SpredrError {}
/** 409: it changed meanwhile (a name taken, a question already answered, an attempt that is over). */
export class ConflictError extends SpredrError {}
/** 429: too many, or a cap reached (the month's tasks, the day's spend); `retryAfter` says when to come back. */
export class RateLimitError extends SpredrError {
  /** Seconds ai asked to wait, when it said. */
  readonly retryAfter: number | null;

  constructor(status: number, message: string, trace = '', retryAfter: number | null = null) {
    super(status, message, trace);
    this.retryAfter = retryAfter;
  }
}
/** 5xx: ai failed; retried already, as far as it is safe. */
export class InternalServerError extends SpredrError {}
/** No answer: the network, a DNS name, ai unreachable. */
export class ConnectionError extends SpredrError {}
/** No answer in time (timeoutMs). */
export class TimeoutError extends ConnectionError {}

/** A task that ended without a result: failed, canceled, or paused for a question someone must answer. */
export class TaskError extends Error {
  readonly task: Task<unknown>;

  constructor(task: Task<unknown>) {
    super(task.status === 'failed' ? task.error || 'The task failed.' : task.status === 'paused' ? 'The task waits for an answer: see pauses().' : `The task is ${task.status}.`);
    this.name = 'TaskError';
    this.task = task;
  }
}

const BY_STATUS = new Map<number, typeof SpredrError>([[400, BadRequestError], [401, AuthenticationError], [403, PermissionDeniedError], [404, NotFoundError], [409, ConflictError]]);

/** The error for ai's answer: its status picks the class. */
export function errorFor(status: number, message: string, trace: string, retryAfter: number | null): SpredrError {
  if (status === 429) return new RateLimitError(status, message, trace, retryAfter);
  if (status >= 500) return new InternalServerError(status, message, trace);
  const Class = BY_STATUS.get(status) ?? SpredrError;
  return new Class(status, message, trace);
}
