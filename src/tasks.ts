// What an owner and a backend share: asking an agent for tasks and following them. The backend sees only its own.

import { TaskError } from './errors.ts';
import { query, type Client } from './http.ts';
import type { Answer, AnyKinds, AskOptions, Feedback, Json, Kinds, Pause, Step, Task, TaskEvent } from './types.ts';

const MAX_WAIT_S = 60;

export class Tasks<K extends Kinds = AnyKinds> {
  #client: Client;
  #agent: string;

  constructor(client: Client, agent: string) {
    this.#client = client;
    this.#agent = agent;
  }

  /** Asks the agent for a task. With `wait`, answers once it is done (or when the wait runs out). With a `key`, asking
   *  again is the same task, so it is safe to retry. */
  async ask<Name extends keyof K & string>(kind: Name, input: K[Name]['input'], options: AskOptions = {}): Promise<Task<K[Name]['output']>> {
    const body = { kind, input, ...(options.key ? { key: options.key } : {}), ...(options.wait ? { wait: Math.min(options.wait, MAX_WAIT_S) } : {}), ...(options.at ? { at: new Date(options.at).toISOString() } : {}), ...(options.thread ? { thread: options.thread } : {}) };
    return (await this.#client.call<{ task: Task<K[Name]['output']> }>('POST', `/agents/${encodeURIComponent(this.#agent)}/tasks`, body, { idempotent: Boolean(options.key) })).task;
  }

  /** Asks and waits until the task is done, failed, canceled or paused, however long (in rounds of up to a minute). */
  async run<Name extends keyof K & string>(kind: Name, input: K[Name]['input'], options: Omit<AskOptions, 'wait'> & { timeoutMs?: number } = {}): Promise<Task<K[Name]['output']>> {
    const task = await this.ask(kind, input, { ...options, wait: MAX_WAIT_S });
    return this.settle<K[Name]['output']>(task.id, options.timeoutMs);
  }

  /** Asks, waits, and gives back the result itself; a task that fails, is canceled or waits for an answer throws a
   *  TaskError carrying the task. */
  async result<Name extends keyof K & string>(kind: Name, input: K[Name]['input'], options: Omit<AskOptions, 'wait'> & { timeoutMs?: number } = {}): Promise<K[Name]['output']> {
    const task = await this.run(kind, input, options);
    if (task.status !== 'done') throw new TaskError(task);
    // a done task holds what its handler returned
    return task.result as K[Name]['output'];
  }

  async get<Result = Json>(id: string, wait = 0): Promise<Task<Result>> {
    return (await this.#client.call<{ task: Task<Result> }>('GET', `/tasks/${id}${query({ wait: wait || undefined })}`)).task;
  }

  /** Waits for a task to leave the line: done, failed, canceled or paused. */
  async settle<Result = Json>(id: string, timeoutMs = 10 * 60_000): Promise<Task<Result>> {
    const until = Date.now() + timeoutMs;
    let task = await this.get<Result>(id);
    while ((task.status === 'queued' || task.status === 'running') && Date.now() < until) task = await this.get<Result>(id, MAX_WAIT_S);
    return task;
  }

  async list(options: { status?: Task['status']; limit?: number; before?: string; thread?: string } = {}): Promise<Task[]> {
    return (await this.#client.call<{ tasks: Task[] }>('GET', `/agents/${encodeURIComponent(this.#agent)}/tasks${query(options)}`)).tasks;
  }

  /** What happened to a task after `after` (its events' seq); with `wait` seconds, waits for the first new one. */
  async events(id: string, after = 0, wait = 0): Promise<TaskEvent[]> {
    return (await this.#client.call<{ events: TaskEvent[] }>('GET', `/tasks/${id}/events${query({ after: after || undefined, wait: wait || undefined })}`)).events;
  }

  /** What the agent did inside a task, step by step: its trace. */
  async steps(id: string): Promise<(Step & { seq: number; at: string })[]> {
    return (await this.#client.call<{ steps: (Step & { seq: number; at: string })[] }>('GET', `/tasks/${id}/steps`)).steps;
  }

  async cancel(id: string): Promise<Task> {
    return (await this.#client.call<{ task: Task }>('POST', `/tasks/${id}/cancel`, {})).task;
  }

  /** The questions waiting for an answer. */
  async pauses(): Promise<Pause[]> {
    return (await this.#client.call<{ pauses: Pause[] }>('GET', `/agents/${encodeURIComponent(this.#agent)}/pauses`)).pauses;
  }

  async answer(pauseId: string, answer: Answer): Promise<Pause> {
    return (await this.#client.call<{ pause: Pause }>('POST', `/pauses/${pauseId}/answer`, answer)).pause;
  }

  /** How a finished task went: what the agent learns from. A bad one also takes back what it did alone. */
  async feedback(id: string, verdict: 'good' | 'bad', details: { correction?: Json; note?: string } = {}): Promise<Feedback> {
    return (await this.#client.call<{ feedback: Feedback }>('POST', `/tasks/${id}/feedback`, { verdict, ...details })).feedback;
  }
}
