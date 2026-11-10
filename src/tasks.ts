// What an owner and a backend share: asking an agent for tasks and following them. The backend sees only its own.
// `for(tenant)` is the same, for one of the many the agent works for at once (a user, an account, a team, a
// business): every task it asks is that tenant's, and it reads and sets what is that tenant's own (its questions,
// usage, caps, lessons, freedom).

import { TaskError } from './errors.ts';
import { query, type Client } from './http.ts';
import type { Answer, AnyKinds, AskOptions, Feedback, Freedom, Json, Kinds, Lesson, Pause, SessionFile, Step, StreamEvent, Task, TaskEvent, TenantInfo, TenantLimits } from './types.ts';

const MAX_WAIT_S = 60;

export class Tasks<K extends Kinds = AnyKinds> {
  #client: Client;
  #agent: string;
  #tenant: string | undefined;

  constructor(client: Client, agent: string, tenant?: string) {
    this.#client = client;
    this.#agent = agent;
    this.#tenant = tenant;
  }

  /** The same agent, working for one tenant: `caller.for('user_42').result('reply', …)`. One agent serves any number
   *  of tenants at once, each with its own memory, questions, freedom, lessons and caps. */
  for(tenant: string): Tenant<K> {
    return new Tenant<K>(this.#client, this.#agent, tenant);
  }

  /** Asks the agent for a task. With `wait`, answers once it is done (or when the wait runs out). With a `key`, asking
   *  again is the same task, so it is safe to retry. */
  async ask<Name extends keyof K & string>(kind: Name, input: K[Name]['input'], options: AskOptions = {}): Promise<Task<K[Name]['output']>> {
    const tenant = options.tenant ?? this.#tenant;
    const body = {
      kind, input, ...(options.key ? { key: options.key } : {}), ...(options.wait ? { wait: Math.min(options.wait, MAX_WAIT_S) } : {}),
      ...(options.at ? { at: new Date(options.at).toISOString() } : {}), ...(options.thread ? { thread: options.thread } : {}), ...(tenant ? { tenant } : {}), ...(options.title ? { title: options.title } : {}),
    };
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

  async list(options: { status?: Task['status']; limit?: number; before?: string; thread?: string; tenant?: string } = {}): Promise<Task[]> {
    const tenant = options.tenant ?? this.#tenant;
    return (await this.#client.call<{ tasks: Task[] }>('GET', `/agents/${encodeURIComponent(this.#agent)}/tasks${query({ ...options, tenant })}`)).tasks;
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

  /** The questions waiting for an answer (a tenant's alone, in a tenant session). */
  async pauses(): Promise<Pause[]> {
    return (await this.#client.call<{ pauses: Pause[] }>('GET', `/agents/${encodeURIComponent(this.#agent)}/pauses${query({ tenant: this.#tenant })}`)).pauses;
  }

  async answer(pauseId: string, answer: Answer): Promise<Pause> {
    return (await this.#client.call<{ pause: Pause }>('POST', `/pauses/${pauseId}/answer`, answer)).pause;
  }

  /** How a finished task went: what the agent learns from. A bad one also takes back what it did alone. */
  async feedback(id: string, verdict: 'good' | 'bad', details: { correction?: Json; note?: string } = {}): Promise<Feedback> {
    return (await this.#client.call<{ feedback: Feedback }>('POST', `/tasks/${id}/feedback`, { verdict, ...details })).feedback;
  }

  /** A task as it happens: each piece of its live answer (the agent's ctx.stream), each of its other events, and last the
   *  task itself once it is done, paused or failed. A stream that closes before the end is opened again after what
   *  was seen, so nothing comes twice. */
  async *stream(id: string): AsyncGenerator<StreamEvent> {
    let after = 0;
    for (;;) {
      for await (const sent of this.#client.events(`/tasks/${encodeURIComponent(id)}/stream`, after)) {
        // ai's own JSON, on our own signed request: its shape is ai's
        const parsed: unknown = JSON.parse(sent.data);
        if (sent.event === 'task') {
          yield { type: 'end', task: parsed as Task };
          return;
        }
        after = sent.id || after;
        const event = parsed as TaskEvent;
        const text = typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data) && typeof event.data.text === 'string' ? event.data.text : '';
        yield sent.event === 'delta' ? { type: 'delta', text, seq: event.seq } : { type: 'event', event };
      }
    }
  }

  /** Asks for a task and gives its live answer as it is written: the pieces, then the task. */
  async *live<Name extends keyof K & string>(kind: Name, input: K[Name]['input'], options: AskOptions = {}): AsyncGenerator<StreamEvent> {
    const task = await this.ask(kind, input, { ...options, wait: 0 });
    yield* this.stream(task.id);
  }

  /** Leaves a file in a session (a thread) for the agent's code to read: a price list, a catalogue, a document. Every
   *  task of that thread lists it (ctx.files) and the agent downloads it (ctx.file) while it works on one. The same
   *  name again replaces it. spredr keeps the bytes and never opens them; how the agent reads them is its code's. */
  async attach(thread: string, name: string, data: Uint8Array | string, options: { type?: string; tenant?: string } = {}): Promise<SessionFile> {
    const tenant = options.tenant ?? this.#tenant;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const path = `/agents/${encodeURIComponent(this.#agent)}/files${query({ thread, file: name, ...(tenant ? { tenant } : {}) })}`;
    return (await this.#client.upload<{ file: SessionFile }>(path, bytes, { 'x-spredr-file-type': options.type ?? (typeof data === 'string' ? 'text/plain' : 'application/octet-stream') })).file;
  }

  /** A session's files, without their bytes, newest first. */
  async files(thread: string, options: { tenant?: string } = {}): Promise<SessionFile[]> {
    const tenant = options.tenant ?? this.#tenant;
    return (await this.#client.call<{ files: SessionFile[] }>('GET', `/agents/${encodeURIComponent(this.#agent)}/files${query({ thread, ...(tenant ? { tenant } : {}) })}`)).files;
  }

  /** Takes a file out of a session. */
  async detach(thread: string, name: string, options: { tenant?: string } = {}): Promise<void> {
    const tenant = options.tenant ?? this.#tenant;
    await this.#client.call('DELETE', `/agents/${encodeURIComponent(this.#agent)}/files${query({ thread, file: name, ...(tenant ? { tenant } : {}) })}`);
  }

  /** The client and agent a tenant session works with. */
  protected get base(): { client: Client; agent: string } {
    return { client: this.#client, agent: this.#agent };
  }
}

/** One tenant of an agent: its tasks, and what is its own. Made with `caller.for(tenant)` or `spredr.agent(name).for(tenant)`. */
export class Tenant<K extends Kinds = AnyKinds> extends Tasks<K> {
  readonly name: string;
  readonly #path: string;

  constructor(client: Client, agent: string, tenant: string) {
    super(client, agent, tenant);
    this.name = tenant;
    this.#path = `/agents/${encodeURIComponent(agent)}/tenants/${encodeURIComponent(tenant)}`;
  }

  /** What it used today and this month, its caps, the facts it holds and its open questions. */
  async usage(): Promise<TenantInfo> {
    return (await this.base.client.call<{ tenant: TenantInfo }>('GET', this.#path)).tenant;
  }

  /** Caps this tenant on top of the agent's own; null lifts one. */
  async setLimits(limits: TenantLimits): Promise<Required<TenantLimits>> {
    return (await this.base.client.call<{ caps: Required<TenantLimits> }>('PUT', `${this.#path}/limits`, limits)).caps;
  }

  /** Forgets this tenant whole: its tasks, memory, questions, freedom, lessons and caps. The others stay. */
  async forget(): Promise<{ tasks: number; facts: number }> {
    return (await this.base.client.call<{ forgotten: { tasks: number; facts: number } }>('DELETE', this.#path)).forgotten;
  }

  /** How free the agent is with each action for this tenant. */
  async freedom(): Promise<Freedom[]> {
    return (await this.base.client.call<{ freedom: Freedom[] }>('GET', `/agents/${encodeURIComponent(this.base.agent)}/freedom${query({ tenant: this.name })}`)).freedom;
  }

  /** Lets an action run alone for this tenant (auto), or ask every time (ask): never for another tenant. */
  async setFreedom(action: string, level: 'ask' | 'auto'): Promise<Freedom> {
    return (await this.base.client.call<{ freedom: Freedom }>('PUT', `/agents/${encodeURIComponent(this.base.agent)}/freedom/${encodeURIComponent(action)}`, { level, tenant: this.name })).freedom;
  }

  /** This tenant's lessons: its own rules, in every one of its tasks from the moment they are written. */
  async lessons(): Promise<Lesson[]> {
    return (await this.base.client.call<{ lessons: Lesson[] }>('GET', `/agents/${encodeURIComponent(this.base.agent)}/lessons${query({ tenant: this.name })}`)).lessons;
  }

  /** Teaches the agent a rule for this tenant alone («we never book on Sundays»). */
  async teach(text: string, why = ''): Promise<Lesson> {
    return (await this.base.client.call<{ lesson: Lesson }>('POST', `/agents/${encodeURIComponent(this.base.agent)}/lessons`, { text, why, tenant: this.name })).lesson;
  }

  /** Accepts or refuses a lesson the agent proposed for this tenant, or retires one. */
  async decide(lessonId: string, decision: 'accept' | 'refuse' | 'retire'): Promise<Lesson> {
    return (await this.base.client.call<{ lesson: Lesson }>('POST', `/agents/${encodeURIComponent(this.base.agent)}/lessons/${lessonId}`, { decision })).lesson;
  }
}
