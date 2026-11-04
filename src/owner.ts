// An owner, with their spredr token: their agents, the backends that may call them, and everything the agents keep.

import { client, query, type Client, type ClientOptions } from './http.ts';
import { Tasks, type Tenant } from './tasks.ts';
import type { AgentInfo, Fact, Freedom, Json, Lesson, LessonVersion, Limits, MemoryUse, Pause, Redeploy, SessionFile, Summary, Task, TenantLimits, TenantUsage, Thread, Traces } from './types.ts';

export interface SpredrOptions extends ClientOptions {
  /** A spredr token (spr_…), from Account › Tokens or `spredr login`; SPREDR_TOKEN when absent. */
  token?: string;
  /** Where ai is; SPREDR_AI_URL, or spredr's own. */
  ai?: string;
}

export const DEFAULT_AI_URL = 'https://api.spredr.cloud/ai';

export class Spredr {
  #client: Client;

  constructor(options: SpredrOptions = {}) {
    const { token: given, ai, ...clientOptions } = options;
    const token = given || process.env.SPREDR_TOKEN;
    if (!token) throw new Error('SPREDR_TOKEN is not set: make an API token in the panel (Account › API tokens), or pass { token }.');
    this.#client = client(ai || process.env.SPREDR_AI_URL || DEFAULT_AI_URL, { token }, clientOptions);
  }

  async agents(): Promise<AgentInfo[]> {
    return (await this.#client.call<{ agents: AgentInfo[] }>('GET', '/agents')).agents;
  }

  /** Turns a spredr service into an agent: ai writes its keys into the service and deploys it again. A deploy spredr
   *  refuses (redeploy.status «failed») leaves the agent made: deploy the service again once that is fixed. */
  async register(name: string, service: string, options: { redeploy?: boolean } = {}): Promise<AgentInfo & { redeploy: Redeploy }> {
    const made = await this.#client.call<{ agent: AgentInfo; redeploy: Redeploy }>('POST', '/agents', { name, service, ...options });
    return { ...made.agent, redeploy: made.redeploy };
  }

  /** Leaves a token for ai to wake and put to sleep your agents while nobody is looking. */
  async keepToken(token: string): Promise<void> {
    await this.#client.call('PUT', '/me/key', { token });
  }

  /** What waits for a person across every agent: open questions, tasks that failed in the last `hours`, and agents whose
   *  memory is 80 % full or more. */
  async inbox(hours = 24): Promise<{ questions: (Pause & { agent: string })[]; errors: Task[]; memory: { agent: string; usedBytes: number; maxBytes: number; full: boolean }[] }> {
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

  /** The agent working for one tenant: its tasks, usage, caps, lessons and freedom, and forgetting it. */
  for(tenant: string): Tenant {
    return this.tasks.for(tenant);
  }

  /** The tenants it worked for in the last `days`, the latest active first, each with what it used. */
  async tenants(options: { days?: number; limit?: number } = {}): Promise<TenantUsage[]> {
    return (await this.#client.call<{ tenants: TenantUsage[] }>('GET', `${this.#path}/tenants${query(options)}`)).tenants;
  }

  /** The caps of every tenant without caps of its own. */
  async setTenantLimits(limits: TenantLimits): Promise<Required<TenantLimits>> {
    return (await this.#client.call<{ caps: Required<TenantLimits> }>('PUT', `${this.#path}/tenants/*/limits`, limits)).caps;
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

  /** Sends each finished task to your OpenTelemetry endpoint (OTLP/HTTP: Langfuse, Datadog, Honeycomb, your collector)
   *  as a trace. headers carry its key (sealed by ai, never shown back); withContent sends the input and result too. */
  async setTraces(traces: { endpoint: string; headers?: Record<string, string>; withContent?: boolean }): Promise<Traces> {
    return (await this.#client.call<{ traces: Traces }>('PUT', `${this.#path}/traces`, traces)).traces;
  }

  /** Where its traces go (the header names only), or null. */
  async traces(): Promise<Traces | null> {
    return (await this.#client.call<{ traces: Traces | null }>('GET', `${this.#path}/traces`)).traces;
  }

  async stopTraces(): Promise<void> {
    await this.#client.call('DELETE', `${this.#path}/traces`);
  }

  async remove(): Promise<void> {
    await this.#client.call('DELETE', this.#path);
  }

  /** A new key pair: ai believes the new key at once, whatever the redeploy does (redeploy.status says). */
  async rotateKey(options: { redeploy?: boolean } = {}): Promise<AgentInfo & { redeploy: Redeploy }> {
    const rotated = await this.#client.call<{ agent: AgentInfo; redeploy: Redeploy }>('POST', `${this.#path}/rotate`, options);
    return { ...rotated.agent, redeploy: rotated.redeploy };
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

  /** Every file its sessions keep, newest first (each with its tenant, conversation and place in the bucket), and how full
   *  its room for them is. */
  async storedFiles(options: { before?: string; limit?: number } = {}): Promise<{ files: SessionFile[]; usedBytes: number; maxBytes: number }> {
    return this.#client.call('GET', `${this.#path}/stored-files${query(options)}`);
  }

  /** One of them, as its bytes and type: any session's. */
  async downloadFile(id: string): Promise<{ data: Uint8Array; type: string }> {
    const got = await this.#client.download(`${this.#path}/stored-files/${encodeURIComponent(id)}`);
    return { data: got.data, type: got.type };
  }

  /** Removes one, any session's: its card and its bytes. */
  async deleteFile(id: string): Promise<void> {
    await this.#client.call('DELETE', `${this.#path}/stored-files/${encodeURIComponent(id)}`);
  }

  /** How full its memory is (warn from 80 %, full from 95 %), and whether unchanged facts are forgotten. */
  async memoryUse(): Promise<MemoryUse> {
    return (await this.#client.call<{ use: MemoryUse }>('GET', `${this.#path}/memory/use`)).use;
  }

  /** What it remembers; `tenant` narrows it to one tenant's. */
  async memory(options: { scope?: string; q?: string; limit?: number; tenant?: string } = {}): Promise<Fact[]> {
    return (await this.#client.call<{ facts: Fact[] }>('GET', `${this.#path}/memory${query(options)}`)).facts;
  }

  async editFact(id: string, text: string, data?: Json): Promise<Fact> {
    return (await this.#client.call<{ fact: Fact }>('PATCH', `${this.#path}/memory/${id}`, { text, ...(data === undefined ? {} : { data }) })).fact;
  }

  /** Erases everything the agent keeps under a scope (a customer who asks to be forgotten): the agent's own, or one
   *  tenant's. */
  async forget(scope: string, tenant?: string): Promise<number> {
    return (await this.#client.call<{ forgotten: number }>('POST', `${this.#path}/memory/forget`, { scope, ...(tenant ? { tenant } : {}) })).forgotten;
  }

  /** How free it is with each action in its own work (no tenant); a tenant's is `for(tenant).freedom()`. */
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
