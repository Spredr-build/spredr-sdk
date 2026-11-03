// The agent side: say hello, take tasks, report. Each task is answered at once with 202 and its handler runs after,
// with a heartbeat so a long task keeps its place; whatever it returns is its result, whatever it throws its error.
// ctx.ask() stops the task to ask before acting: the task comes back later with the answer and the handler runs again
// from the top, so a handler is written to be run again (remember what is done, check before doing it twice).

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { client, query, type Client } from './http.ts';
import { aiVerifier, privateKeyOf } from './sign.ts';
import type { Answer, Fact, Feedback, Json, Step, Task } from './types.ts';

export interface Manifest {
  description?: string;
  tasks?: { kind: string; description?: string }[];
  /** The actions it asks about first; neverAuto: it asks every time, however often it was approved. */
  actions?: { name: string; neverAuto?: boolean }[];
  sleepAfterMinutes?: number | null;
  concurrency?: number;
  timeoutSeconds?: number;
  judge?: string | null;
  /** The tools it can use, for its owner to see; asks: it asks before using it. */
  tools?: { name: string; description?: string; asks?: boolean }[];
}

export interface Delivery {
  task: { id: string; kind: string; input: Json; attempt: number; by: Task['by']; trial: boolean; judges: string | null; createdAt: string };
  resume: (Answer & { pause: string; action: string }) | null;
  lessons: { version: number; items: string[] };
}

export interface Context {
  task: Delivery['task'];
  /** The live lessons this task carries: put them in the prompt. */
  lessons: string[];
  /** A trial replays an old task with new lessons: do nothing real. */
  trial: boolean;
  /** Asks before an action and returns the answer; the first time the task stops here and comes back with it. */
  ask(action: string, question: string, extra?: { options?: string[]; data?: Json }): Promise<Answer>;
  progress(data: Json): Promise<void>;
  /** Reports one step it took (a model call, a tool): its trace and its costs come from these. */
  step(step: Step): Promise<void>;
  /** Runs `work`, times it, and reports it as a step (failed when it throws). Tokens and cost from what it returns, if
   *  `usage` reads them. */
  track<T>(kind: Step['kind'], name: string, work: () => Promise<T>, usage?: (value: T) => Pick<Step, 'model' | 'tokensIn' | 'tokensOut' | 'costUsd' | 'detail'>): Promise<T>;
  /** A task for later (a reminder, a follow-up). */
  later(kind: string, input: Json, at: Date | string, key?: string): Promise<void>;
  memory: {
    remember(scope: string, text: string, extra?: { key?: string; data?: Json }): Promise<Fact>;
    recall(options: { scope?: string; q?: string; limit?: number }): Promise<Fact[]>;
    forget(id: string): Promise<void>;
  };
}

export type Handler = (input: Json, ctx: Context) => Promise<Json> | Json;

export interface AgentOptions extends Manifest {
  id?: string;
  key?: string;
  ai?: string;
  aiKey?: string;
  fetch?: typeof fetch;
}

/** Thrown inside ask() to stop a task that waits for an answer; the SDK catches it. */
const PAUSED = Symbol('paused');
const MAX_BODY = 4 * 1024 * 1024;
const HELLO_TRIES = 30;

function read(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    request.on('end', () => resolve(size <= MAX_BODY ? Buffer.concat(chunks) : null));
    request.on('error', () => resolve(null));
  });
}

export class Agent {
  #manifest: Manifest;
  #client: Client;
  #verify: ReturnType<typeof aiVerifier>;
  #handlers = new Map<string, Handler>();
  #taskPath = '/spredr/task';
  #log: (line: string) => void = (line) => console.log(`spredr agent · ${line}`);

  constructor(options: AgentOptions = {}) {
    const need = (value: string | undefined, name: string): string => {
      if (!value) throw new Error(`${name} is not set: register this service as an agent on spredr (it writes the variables), or pass the options.`);
      return value;
    };
    const { id, key, ai, aiKey, fetch: fetcher, ...manifest } = options;
    this.#manifest = manifest;
    this.#client = client(need(ai ?? process.env.SPREDR_AI_URL, 'SPREDR_AI_URL'), { from: need(id ?? process.env.SPREDR_AGENT_ID, 'SPREDR_AGENT_ID'), key: privateKeyOf(need(key ?? process.env.SPREDR_AGENT_KEY, 'SPREDR_AGENT_KEY')) }, fetcher);
    this.#verify = aiVerifier(need(aiKey ?? process.env.SPREDR_AI_KEY, 'SPREDR_AI_KEY'));
  }

  /** What to do with one kind of task. The kinds you name are the ones ai sends you. */
  on(kind: string, handler: Handler): this {
    this.#handlers.set(kind, handler);
    return this;
  }

  /** Says hello with the manifest (retrying while ai is not reachable yet). */
  async hello(): Promise<void> {
    const kinds = [...this.#handlers.keys()].filter((kind) => kind !== this.#manifest.judge);
    const declared = this.#manifest.tasks ?? kinds.map((kind) => ({ kind }));
    for (let tries = 1; ; tries++) {
      try {
        await this.#client.call('POST', '/agent/hello', { ...this.#manifest, tasks: declared });
        return;
      } catch (error) {
        if (tries >= HELLO_TRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  /** Listens for tasks (and answers /health), then says hello. */
  async listen(port = Number(process.env.PORT ?? 8080)): Promise<Server> {
    const server = createServer((request, response) => void this.#serve(request, response.writeHead.bind(response), (body) => response.end(body)));
    await new Promise<void>((resolve) => server.listen(port, resolve));
    this.#log(`listening on ${port}`);
    await this.hello();
    this.#log('said hello to ai');
    process.once('SIGTERM', () => server.close(() => process.exit(0)));
    return server;
  }

  async #serve(request: IncomingMessage, head: (status: number, headers?: Record<string, string>) => unknown, end: (body?: string) => unknown): Promise<void> {
    if (request.url === '/health') {
      head(200);
      end('ok');
      return;
    }
    if (request.method !== 'POST' || request.url !== this.#taskPath) {
      head(404);
      end();
      return;
    }
    const body = await read(request);
    if (!body || !this.#verify({ method: 'POST', path: request.url, headers: request.headers, body })) {
      head(401, { 'content-type': 'application/json' });
      end(JSON.stringify({ error: 'not signed by ai' }));
      return;
    }
    // ai's own JSON, checked by its signature
    const delivery = JSON.parse(body.toString('utf8')) as Delivery;
    const handler = this.#handlers.get(delivery.task.kind);
    if (!handler) {
      head(200, { 'content-type': 'application/json' });
      end(JSON.stringify({ error: `this agent does not handle «${delivery.task.kind}» tasks` }));
      return;
    }
    head(202);
    end();
    await this.#run(handler, delivery);
  }

  async #run(handler: Handler, delivery: Delivery): Promise<void> {
    const { task } = delivery;
    const path = `/agent/tasks/${task.id}`;
    const beatMs = Math.max(5_000, ((this.#manifest.timeoutSeconds ?? 120) * 1000) / 3);
    const beat = setInterval(() => void this.#client.call('POST', `${path}/progress`, { attempt: task.attempt, data: { alive: true } }).catch(() => undefined), beatMs);
    try {
      const result = await handler(task.input, this.#context(delivery));
      await this.#client.call('POST', `${path}/result`, { attempt: task.attempt, result: result ?? null });
    } catch (error) {
      if (error === PAUSED) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.#client.call('POST', `${path}/result`, { attempt: task.attempt, error: message.slice(0, 2_000) || 'failed' }).catch((reportError: unknown) => this.#log(`could not report ${task.id}: ${String(reportError)}`));
    } finally {
      clearInterval(beat);
    }
  }

  #context(delivery: Delivery): Context {
    const { task } = delivery;
    const call = this.#client.call.bind(this.#client);
    const began = Date.now();
    return {
      task, lessons: delivery.lessons.items, trial: task.trial,
      async ask(action, question, extra = {}) {
        if (delivery.resume && delivery.resume.action === action) return delivery.resume;
        const { pause } = await call<{ pause: { status: string; answer: Answer | null } }>('POST', `/agent/tasks/${task.id}/pause`, { attempt: task.attempt, action, question, ...extra });
        if (pause.status === 'answered' && pause.answer) return pause.answer;
        throw PAUSED;
      },
      async progress(data) {
        await call('POST', `/agent/tasks/${task.id}/progress`, { attempt: task.attempt, data });
      },
      async step(step) {
        await call('POST', `/agent/tasks/${task.id}/steps`, { attempt: task.attempt, steps: [step] });
      },
      async track(kind, name, work, usage) {
        const started = Date.now();
        const at = started - began;
        try {
          const value = await work();
          await call('POST', `/agent/tasks/${task.id}/steps`, { attempt: task.attempt, steps: [{ kind, name, ms: Date.now() - started, at, ...(usage ? usage(value) : {}) }] }).catch(() => undefined);
          return value;
        } catch (error) {
          await call('POST', `/agent/tasks/${task.id}/steps`, { attempt: task.attempt, steps: [{ kind, name, ms: Date.now() - started, at, ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : 'failed' }] }).catch(() => undefined);
          throw error;
        }
      },
      async later(kind, input, at, key) {
        await call('POST', '/agent/tasks', { kind, input, at: new Date(at).toISOString(), ...(key ? { key } : {}) });
      },
      memory: {
        async remember(scope, text, extra = {}) {
          return (await call<{ fact: Fact }>('PUT', '/agent/memory', { scope, text, ...extra })).fact;
        },
        async recall(options) {
          return (await call<{ facts: Fact[] }>('GET', `/agent/memory${query(options)}`)).facts;
        },
        async forget(id) {
          await call('DELETE', `/agent/memory/${id}`);
        },
      },
    };
  }

  /** What apps said about this agent's tasks after `after` (a feedback seq): what it learns from. */
  async feedback(after = 0): Promise<(Feedback & { task: Task | null })[]> {
    return (await this.#client.call<{ feedback: (Feedback & { task: Task | null })[] }>('GET', `/agent/feedback${query({ after: after || undefined })}`)).feedback;
  }

  /** Proposes a lesson to its owner, drawn from feedback. */
  async propose(text: string, why = '', sources: string[] = []): Promise<void> {
    await this.#client.call('POST', '/agent/lessons', { text, why, sources });
  }
}
