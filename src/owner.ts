// An owner, with their spredr token: their agents, the backends that may call them, and everything the agents keep.

import { client, query, type Client } from './http.ts';
import { Tasks } from './tasks.ts';
import type { AgentInfo, Fact, Freedom, Json, Lesson, LessonVersion, Limits, Pause, Summary, Task, Thread } from './types.ts';

export interface SpredrOptions {
  /** A spredr token (spr_…), from Account › Tokens or `spredr login`. */
  token: string;
  /** Where ai is; SPREDR_AI_URL, or spredr's own. */
  ai?: string;
  fetch?: typeof fetch;
}

export const DEFAULT_AI_URL = 'https://ai.spredr.cloud';

export class Spredr {
  #client: Client;

  constructor(options: SpredrOptions) {
    this.#client = client(options.ai ?? process.env.SPREDR_AI_URL ?? DEFAULT_AI_URL, { token: options.token }, options.fetch);
  }

  async agents(): Promise<AgentInfo[]> {
    return (await this.#client.call<{ agents: AgentInfo[] }>('GET', '/agents')).agents;
  }

  /** Turns a spredr service into an agent: ai writes its keys into the service and deploys it again. */
  async register(name: string, service: string, options: { redeploy?: boolean } = {}): Promise<AgentInfo> {
    return (await this.#client.call<{ agent: AgentInfo }>('POST', '/agents', { name, service, ...options })).agent;
  }

  /** Leaves a token for ai to wake and put to sleep your agents while nobody is looking. */
  async keepToken(token: string): Promise<void> {
    await this.#client.call('PUT', '/me/key', { token });
  }

  /** What waits for a person across every agent: open questions, and tasks that failed in the last `hours`. */
  async inbox(hours = 24): Promise<{ questions: (Pause & { agent: string })[]; errors: Task[] }> {
    return this.#client.call('GET', `/inbox${query({ hours })}`);
  }

  agent(name: string): OwnedAgent {
    return new OwnedAgent(this.#client, name);
  }
}

export class OwnedAgent {
  #client: Client;
  #path: string;
  readonly tasks: Tasks;

  constructor(client: Client, name: string) {
    this.#client = client;
    this.#path = `/agents/${encodeURIComponent(name)}`;
    this.tasks = new Tasks(client, name);
  }

  async info(): Promise<AgentInfo> {
    return (await this.#client.call<{ agent: AgentInfo }>('GET', this.#path)).agent;
  }

  /** Its last hours at a glance: tasks, failures, times, tokens, cost, tools, and how free it is. */
  async summary(hours = 24): Promise<Summary> {
    return (await this.#client.call<{ summary: Summary }>('GET', `${this.#path}/summary${query({ hours })}`)).summary;
  }

  /** Its conversations: tasks that share a thread. Read one with tasks.list({ thread }). */
  async threads(limit = 50): Promise<Thread[]> {
    return (await this.#client.call<{ threads: Thread[] }>('GET', `${this.#path}/threads${query({ limit })}`)).threads;
  }

  /** Every task since a moment with its steps (the export, read line by line). */
  async export(since?: Date | string): Promise<(Task & { steps: Json[] })[]> {
    const text = await this.#client.text('GET', `${this.#path}/export${query({ since: since ? new Date(since).toISOString() : undefined })}`);
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Task & { steps: Json[] });
  }

  async setLimits(limits: Limits): Promise<AgentInfo> {
    return (await this.#client.call<{ agent: AgentInfo }>('PUT', `${this.#path}/limits`, limits)).agent;
  }

  async remove(): Promise<void> {
    await this.#client.call('DELETE', this.#path);
  }

  async rotateKey(options: { redeploy?: boolean } = {}): Promise<AgentInfo> {
    return (await this.#client.call<{ agent: AgentInfo }>('POST', `${this.#path}/rotate`, options)).agent;
  }

  /** A backend that may give this agent tasks. With `service`, ai writes its key there; with `publicKey`, the private
   *  one never leaves you; with neither, the private key comes back this once. With `everything` and a `callbackUrl`, it
   *  is an events webhook: it hears about every task of the agent (task.created, done, failed, paused, canceled). */
  async addCaller(name: string, options: { service?: string; publicKey?: string; callbackUrl?: string; everything?: boolean; redeploy?: boolean } = {}) {
    return this.#client.call<{ caller: { id: string; name: string; publicKey: string; callbackUrl: string }; privateKey?: string }>('POST', `${this.#path}/callers`, { name, ...options });
  }

  async callers() {
    return (await this.#client.call<{ callers: { id: string; name: string; service: string; callbackUrl: string }[] }>('GET', `${this.#path}/callers`)).callers;
  }

  async removeCaller(id: string): Promise<void> {
    await this.#client.call('DELETE', `${this.#path}/callers/${id}`);
  }

  async schedule(name: string, kind: string, cron: string, options: { tz?: string; input?: Json } = {}) {
    return (await this.#client.call<{ schedule: { id: string; nextAt: string } }>('POST', `${this.#path}/schedules`, { name, kind, cron, ...options })).schedule;
  }

  /** A secret address that starts a task with whatever is POSTed to it; the address comes back this once. */
  async hook(name: string, kind: string) {
    return this.#client.call<{ hook: { id: string; name: string }; url: string }>('POST', `${this.#path}/hooks`, { name, kind });
  }

  async memory(options: { scope?: string; q?: string; limit?: number } = {}): Promise<Fact[]> {
    return (await this.#client.call<{ facts: Fact[] }>('GET', `${this.#path}/memory${query(options)}`)).facts;
  }

  async editFact(id: string, text: string, data?: Json): Promise<Fact> {
    return (await this.#client.call<{ fact: Fact }>('PATCH', `${this.#path}/memory/${id}`, { text, ...(data === undefined ? {} : { data }) })).fact;
  }

  /** Erases everything the agent keeps under a scope (a customer who asks to be forgotten). */
  async forget(scope: string): Promise<number> {
    return (await this.#client.call<{ forgotten: number }>('POST', `${this.#path}/memory/forget`, { scope })).forgotten;
  }

  async freedom(): Promise<Freedom[]> {
    return (await this.#client.call<{ freedom: Freedom[] }>('GET', `${this.#path}/freedom`)).freedom;
  }

  async setFreedom(action: string, level: 'ask' | 'auto'): Promise<Freedom> {
    return (await this.#client.call<{ freedom: Freedom }>('PUT', `${this.#path}/freedom/${encodeURIComponent(action)}`, { level })).freedom;
  }

  async lessons(): Promise<Lesson[]> {
    return (await this.#client.call<{ lessons: Lesson[] }>('GET', `${this.#path}/lessons`)).lessons;
  }

  async writeLesson(text: string, why = ''): Promise<Lesson> {
    return (await this.#client.call<{ lesson: Lesson }>('POST', `${this.#path}/lessons`, { text, why })).lesson;
  }

  async decide(lessonId: string, decision: 'accept' | 'refuse' | 'retire'): Promise<Lesson> {
    return (await this.#client.call<{ lesson: Lesson }>('POST', `${this.#path}/lessons/${lessonId}`, { decision })).lesson;
  }

  async versions(): Promise<LessonVersion[]> {
    return (await this.#client.call<{ versions: LessonVersion[] }>('GET', `${this.#path}/versions`)).versions;
  }

  /** Releases the accepted lessons as a new version, tried first on past tasks. */
  async release(): Promise<LessonVersion> {
    return (await this.#client.call<{ version: LessonVersion }>('POST', `${this.#path}/versions`, {})).version;
  }

  async version(version: number, action: 'publish' | 'rollback' | 'discard'): Promise<LessonVersion> {
    return (await this.#client.call<{ version: LessonVersion }>('POST', `${this.#path}/versions/${version}`, { action })).version;
  }
}
