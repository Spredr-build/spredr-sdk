// The agent side: say hello, take tasks, report. Each task is answered at once with 202 and its handler runs after,
// with a heartbeat so a long task keeps its place; whatever it returns is its result, whatever it throws its error.
// ctx.ask() stops the task to ask before acting: the task comes back later with the answer and the handler runs again
// from the top, so a handler is written to be run again (remember what is done, check before doing it twice).
// On SIGTERM (a deploy, a stop) it takes no new task and lets the running ones finish, up to shutdownGraceMs.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { contextFor, PAUSED, type Context, type Delivery } from './context.ts';
import { ConflictError } from './errors.ts';
import { client, query, type Client, type ClientOptions } from './http.ts';
import { validated, type InferInput, type InferOutput, type StandardSchemaV1 } from './schema.ts';
import { aiVerifier, privateKeyOf } from './sign.ts';
import type { Feedback, Json, Kinds, Task } from './types.ts';

export type { Context, Delivery } from './context.ts';

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

/** What to do with one kind of task: its input (checked by a schema when given one) in, its result out. */
export type Handler<Input = Json, Output = unknown> = (input: Input, ctx: Context) => Output | Promise<Output>;

export interface AgentOptions extends Manifest, ClientOptions {
  /** ag_…: SPREDR_AGENT_ID. */
  id?: string;
  /** Its private key: SPREDR_AGENT_KEY. */
  key?: string;
  /** Where ai is: SPREDR_AI_URL. */
  ai?: string;
  /** ai's public key, to check that a task comes from ai: SPREDR_AI_KEY. */
  aiKey?: string;
  /** Where its lines go; false says nothing. */
  log?: ((line: string) => void) | false;
  /** On SIGTERM, how long running tasks may finish before it exits, in ms: 25 s by default. */
  shutdownGraceMs?: number;
}

/** The kinds an agent handles, to type a Caller with: `new Caller<KindsOf<typeof agent>>()`. */
export type KindsOf<A> = A extends Agent<infer K> ? K : never;

type Run = (input: Json, ctx: Context) => Promise<unknown>;

const MAX_BODY = 4 * 1024 * 1024;
const HELLO_TRIES = 30;
const SHUTDOWN_GRACE_MS = 25_000;

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

const need = (value: string | undefined, name: string): string => {
  const found = value || process.env[name];
  if (!found) throw new Error(`${name} is not set: register this service as an agent on spredr (it writes the variables), or pass the options.`);
  return found;
};

/** An agent. K starts empty and each on() adds its kind, which is what KindsOf reads. */
export class Agent<K extends Kinds = {}> {
  #manifest: Manifest;
  #client: Client;
  #verify: ReturnType<typeof aiVerifier>;
  #handlers = new Map<string, Run>();
  #taskPath = '/spredr/task';
  #log: (line: string) => void;
  #graceMs: number;
  #running = new Set<Promise<void>>();
  #server: Server | null = null;
  #closing = false;

  constructor(options: AgentOptions = {}) {
    const { id, key, ai, aiKey, fetch, timeoutMs, maxRetries, retryDelayMs, log, shutdownGraceMs, ...manifest } = options;
    this.#manifest = manifest;
    const clientOptions = { ...(fetch ? { fetch } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(maxRetries === undefined ? {} : { maxRetries }), ...(retryDelayMs === undefined ? {} : { retryDelayMs }) };
    this.#client = client(need(ai, 'SPREDR_AI_URL'), { from: need(id, 'SPREDR_AGENT_ID'), key: privateKeyOf(need(key, 'SPREDR_AGENT_KEY')) }, clientOptions);
    this.#verify = aiVerifier(need(aiKey, 'SPREDR_AI_KEY'));
    this.#log = log === false ? () => undefined : log ?? ((line) => console.log(`spredr agent · ${line}`));
    this.#graceMs = shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  }

  /** What to do with one kind of task. The kinds you name are the ones ai sends you. With a schema (zod, valibot,
   *  arktype: any Standard Schema) the input is checked first, and a task whose input does not match fails saying where. */
  on<Name extends string, Input = Json, Output = unknown>(kind: Name, handler: Handler<Input, Output>): Agent<K & { [P in Name]: { input: Input; output: Awaited<Output> } }>;
  on<Name extends string, Schema extends StandardSchemaV1, Output = unknown>(kind: Name, schema: Schema, handler: Handler<InferOutput<Schema>, Output>): Agent<K & { [P in Name]: { input: InferInput<Schema>; output: Awaited<Output> } }>;
  on(kind: string, schemaOrHandler: StandardSchemaV1 | Handler<never, unknown>, maybeHandler?: Handler<never, unknown>): Agent<Kinds> {
    const [schema, handler] = typeof schemaOrHandler === 'function' ? [null, schemaOrHandler] : [schemaOrHandler, maybeHandler];
    if (!handler) throw new Error(`on("${kind}"): a handler is missing.`);
    // the input is ai's JSON as the caller sent it: the handler's declared type, or what its schema made of it
    const run: Run = async (input, ctx) => handler((schema ? await validated(schema, input) : input) as never, ctx);
    this.#handlers.set(kind, run);
    return this;
  }

  /** Says hello with the manifest (retrying while ai is not reachable yet). */
  async hello(): Promise<void> {
    const kinds = [...this.#handlers.keys()].filter((kind) => kind !== this.#manifest.judge);
    const declared = this.#manifest.tasks ?? kinds.map((kind) => ({ kind }));
    for (let tries = 1; ; tries++) {
      try {
        await this.#client.call('POST', '/agent/hello', { ...this.#manifest, tasks: declared }, { idempotent: true });
        return;
      } catch (error) {
        if (tries >= HELLO_TRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  /** Listens for tasks (and answers /health), then says hello. On SIGTERM it closes and exits. */
  async listen(port = Number(process.env.PORT ?? 8080)): Promise<Server> {
    const server = createServer((request, response) => void this.#serve(request, response.writeHead.bind(response), (body) => response.end(body)));
    await new Promise<void>((resolve) => server.listen(port, resolve));
    this.#server = server;
    this.#log(`listening on ${port}`);
    await this.hello();
    this.#log('said hello to ai');
    process.once('SIGTERM', () => void this.close().then(() => process.exit(0)));
    return server;
  }

  /** Takes no new task, and waits for the running ones to finish (up to shutdownGraceMs). */
  async close(): Promise<void> {
    this.#closing = true;
    const closed = this.#server ? new Promise<void>((resolve) => this.#server?.close(() => resolve())) : Promise.resolve();
    const finished = Promise.allSettled([...this.#running]);
    const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), this.#graceMs).unref());
    if ((await Promise.race([finished, late])) === 'late') this.#log(`closing with ${this.#running.size} task(s) still running: ai gives them again`);
    this.#server?.closeAllConnections();
    await closed;
  }

  async #serve(request: IncomingMessage, head: (status: number, headers?: Record<string, string>) => unknown, end: (body?: string) => unknown): Promise<void> {
    if (request.url === '/health') {
      head(this.#closing ? 503 : 200);
      end(this.#closing ? 'closing' : 'ok');
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
    if (this.#closing) {
      head(503, { 'content-type': 'application/json' });
      end(JSON.stringify({ error: 'this agent is closing' }));
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
    const running = this.#run(handler, delivery);
    this.#running.add(running);
    await running.finally(() => this.#running.delete(running));
  }

  async #run(handler: Run, delivery: Delivery): Promise<void> {
    const { task } = delivery;
    const path = `/agent/tasks/${task.id}`;
    const beatMs = Math.max(5_000, ((this.#manifest.timeoutSeconds ?? 120) * 1000) / 3);
    // the server keeps the process alive while it listens; a beat alone never does (a task past the grace is ai's again)
    const beat = setInterval(() => void this.#client.call('POST', `${path}/progress`, { attempt: task.attempt, data: { alive: true } }).catch(() => undefined), beatMs).unref();
    let outcome: { result: unknown } | { error: string };
    try {
      outcome = { result: (await handler(task.input, contextFor(this.#client, delivery))) ?? null };
    } catch (error) {
      if (error === PAUSED) return;
      const message = error instanceof Error ? error.message : String(error);
      outcome = { error: message.slice(0, 2_000) || 'failed' };
    } finally {
      clearInterval(beat);
    }
    // ai closes an attempt once, so sending it again is safe, and a 409 says it was closed already. A result that cannot
    // be sent is never turned into a failure: ai gives the task again when its lease ends.
    try {
      await this.#client.call('POST', `${path}/result`, { attempt: task.attempt, ...outcome }, { idempotent: true });
    } catch (error) {
      if (error instanceof ConflictError) return;
      this.#log(`could not report ${task.id}: ${error instanceof Error ? error.message : String(error)}; ai gives it again when its lease ends`);
    }
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
