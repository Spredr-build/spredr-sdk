// What a handler gets besides its input: the task, its lessons, and the way to ask, remember, report steps and schedule
// more work. Every call goes to ai signed as the agent, under the task's attempt.
//
// A task works for one tenant (ctx.tenant: a user, an account, a team, a business; "" when no one in particular). Its memory calls name the
// task, and ai takes the tenant from it: whatever the model is talked into, a task reaches its own tenant's memory and
// no other's. A task it schedules (ctx.later) is for the same tenant and thread.

import type { Client } from './http.ts';
import { PartError, RateLimitError } from './errors.ts';
import { query } from './http.ts';
import type { Answer, Block, Fact, Json, SessionFile, Step, Task } from './types.ts';
import { usageOf } from './usage.ts';

/** Two JSON values with the same content, whatever the order of their keys. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameJson(Reflect.get(a, key), Reflect.get(b, key)));
}

export interface Delivery {
  /** Whom ai addressed it to, inside what it signs: an agent refuses one addressed to another. Absent from an older ai. */
  to?: { agent: string };
  task: { id: string; kind: string; input: Json; attempt: number; by: Task['by']; trial: boolean; judges: string | null; createdAt: string; tenant?: string; thread?: string | null };
  /** The last answer only: what an ai from before the journal sends. */
  resume: (Answer & { pause: string; action: string; question?: string; data?: Json | null }) | null;
  /** Every answer the task's questions got, in the order asked (free ones too). */
  answers?: (Answer & { pause: string; action: string; auto?: boolean; question?: string; data?: Json | null })[];
  /** What each finished step gave back, in order: `key` is the step as the handler named it. */
  memo?: { key: string; has: boolean; value: Json }[];
  lessons: { version: number; items: string[] };
  /** Its session's files, without their bytes: what an ai from before sessions' files does not send. */
  files?: SessionFile[];
}

export interface Context {
  task: Delivery['task'];
  /** Whom it works for in this task (a user, an account, a team, a business): its memory, freedom, lessons and caps are that tenant's.
   *  "" when the asker named no one. */
  tenant: string;
  /** The conversation it belongs to (a customer, a ticket), when the asker named one. */
  thread: string | null;
  /** The live lessons this task carries: put them in the prompt. */
  lessons: string[];
  /** A trial replays an old task with new lessons: do nothing real. */
  trial: boolean;
  /** Asks before an action and returns the answer; the first time the task stops here and comes back with it. Asked
   *  again when the task runs again, it gives back the same answer without asking. */
  ask(action: string, question: string, extra?: { options?: string[]; data?: Json }): Promise<Answer>;
  progress(data: Json): Promise<void>;
  /** Shows a block in the task's page in spredr's panel: an answer with its sources, findings, an image with what was
   *  read in it, a batch of images, a record, a table or a voice recording (Block). Shown in the order sent, kept with
   *  the task, and part of its export. Up to 256 KB each; media by reference. */
  show(block: Block): Promise<void>;
  /** The next piece of its answer, for whoever watches the task live (the caller's stream()): sent in order, a few at a
   *  time. A view, never the outcome: what the task returns is its result, and the pieces go once it is done. */
  stream(text: string): void;
  /** Sends what stream() and the steps still hold: done for you before the task's result and before a question. */
  flush(): Promise<void>;
  /** Reports one step it took (a model call, a tool): its trace and its costs come from these. Steps go to spredr in
   *  groups, a quarter of a second at most after they are taken; all of them before the task's result. */
  step(step: Step): Promise<void>;
  /** Runs `work`, times it, and reports it as a step (failed when it throws). Tokens and cost from what it returns, if
   *  `usage` reads them. Done once per task: when the task runs again (after a question, a retry) it gives back what
   *  `work` gave the first time, as JSON, without running it. Put side effects here so they never happen twice. */
  track<T>(kind: Step['kind'], name: string, work: () => Promise<T>, usage?: (value: T) => Pick<Step, 'model' | 'tokensIn' | 'tokensOut' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd' | 'detail'>): Promise<T>;
  /** A model call, timed and reported with its model and tokens read from the answer (Claude, OpenAI, the AI SDK):
   *  `await ctx.model(() => claude.messages.create({ … }))`. `name` defaults to the model. Done once per task, as track. */
  model<T>(work: () => Promise<T>, name?: string): Promise<T>;
  /** A task for later (a reminder, a follow-up), for the same tenant and thread. Done once per task, as track. */
  later(kind: string, input: Json, at: Date | string, key?: string): Promise<void>;
  /** Hands a part of this task to another of your agents (by name) and waits for what it gives back: its result, or a
   *  PartError when it failed or was canceled. The part is that agent's own task, for the same tenant and thread, and
   *  the panel draws it under this one. Your owner says in each agent's settings whom it may ask, how many parts at
   *  once (past that, the next waits its turn here) and how long a chain may grow. Asked once: when this task runs
   *  again, the same call gives back the same part (its key is the agent, the kind and how many such parts came
   *  before; pass `key` to name it yourself). Several at once: `await Promise.all([ctx.delegate(…), ctx.delegate(…)])`. */
  delegate<T = Json>(agent: string, kind: string, input?: Json, options?: { title?: string; key?: string }): Promise<T>;
  /** Its session's files (the thread's, for its tenant): whatever its caller left for it to read, without their bytes. */
  files: SessionFile[];
  /** One of them, by id or by name, as its bytes and type: read inside this task, the way its code wants. */
  file(idOrName: string): Promise<{ data: Uint8Array; type: string; name: string }>;
  /** This tenant's memory (this task's): the agent's room is shared by all its tenants, each fact is one tenant's. */
  memory: {
    /** Done once per task, as track. The fact kept, or null when it was not (its room is full, or its tenant's share):
     *  the task goes on either way, and why is printed in its logs. */
    remember(scope: string, text: string, extra?: { key?: string; data?: Json }): Promise<Fact | null>;
    recall(options: { scope?: string; q?: string; limit?: number }): Promise<Fact[]>;
    forget(id: string): Promise<void>;
  };
}

/** Thrown inside ask() to stop a task that waits for an answer; the agent catches it. */
export const PAUSED = Symbol('paused');
/** The most a step leaves for the next run (ai's own limit): past it, the step runs again instead. */
const MAX_MEMO_BYTES = 256 * 1024;

const failedStep = (error: unknown): Pick<Step, 'ok' | 'detail'> => ({ ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : 'failed' });

/** The JSON a memo keeps, or undefined when the value cannot travel (too big, circular, a BigInt): the step then runs
 *  again next time. Nothing given back keeps as nothing. */
function memoOf(value: unknown): { value?: Json } | undefined {
  if (value === undefined) return {};
  try {
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text) > MAX_MEMO_BYTES) return undefined;
    return { value: JSON.parse(text) as Json };
  } catch {
    return undefined;
  }
}

/** How long one ask for a part waits on ai (the agent's heartbeat keeps the task's place meanwhile), how long between
 *  asks while a part waits for a person's answer, and how long before asking again for a turn past the parallel cap. */
const PART_WAIT_SECONDS = 25;
const PART_PAUSED_MS = 5_000;
const PART_TURN_MS = 2_000;
const PART_KEY_MAX = 64;
/** A part's key from the call: only what ai accepts in a key. */
const partKey = (text: string): string => text.replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, PART_KEY_MAX);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
interface Part { id: string; agent: string; kind: string; status: string; result: Json; error: string }

/** How long live text gathers before it is sent, and how much makes it go at once. */
const STREAM_FLUSH_MS = 150;
const STREAM_FLUSH_CHARS = 2_000;
/** Steps go to ai in groups: up to this many in one report (what ai takes at once), gathered this long. One call per
 *  step made a task of 400 steps take minutes over a slow link (22 Nov 2026: 18 min on the dev database). */
const STEPS_PER_REPORT = 50;
const STEPS_FLUSH_MS = 250;

export function contextFor(client: Client, delivery: Delivery): Context {
  const { task } = delivery;
  const call = client.call.bind(client);
  const began = Date.now();
  const path = `/agent/tasks/${encodeURIComponent(task.id)}`;
  // the live text: gathered, and sent one piece after another, so they arrive in the order written
  let pending = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let sending: Promise<void> = Promise.resolve();
  const flushNow = (): Promise<void> => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (pending) {
      const text = pending;
      pending = '';
      // a piece that cannot be sent is lost from the live view only: the result still says all of it
      sending = sending.then(() => call('POST', `${path}/delta`, { attempt: task.attempt, text })).then(() => undefined, () => undefined);
    }
    return sending;
  };
  // the steps: gathered, and sent in order, a group at a time. A step that leaves a memo for the next run goes at once
  // (with those before it): if the process dies, what it did must not run again. Before a question and before the
  // result everything gathered goes (flush). A step that cannot be sent is lost from the trace only, as before.
  let steps: (Step & { memo?: { key: string; value?: Json } })[] = [];
  let stepsTimer: ReturnType<typeof setTimeout> | null = null;
  let reporting: Promise<void> = Promise.resolve();
  let capped = false;
  const sendSteps = (): Promise<void> => {
    if (stepsTimer) clearTimeout(stepsTimer);
    stepsTimer = null;
    while (steps.length) {
      const group = steps.slice(0, STEPS_PER_REPORT);
      steps = steps.slice(STEPS_PER_REPORT);
      reporting = reporting.then(() => call<{ dropped?: number; room?: number }>('POST', `${path}/steps`, { attempt: task.attempt, steps: group })).then((answer) => {
        // past the plan's room for steps the task goes on, its steps are not kept: said once, where its logs are read
        if ((answer?.dropped ?? 0) > 0 && !capped) {
          capped = true;
          console.warn(`spredr: this task reached the ${String(answer?.room ?? '')} steps its plan keeps; the ones after are not kept (its history in spredr says where).`);
        }
      }, () => undefined);
    }
    return reporting;
  };
  const report = (step: Step & { memo?: { key: string; value?: Json } }): Promise<void> => {
    steps.push(step);
    if (step.memo || steps.length >= STEPS_PER_REPORT) return sendSteps();
    if (!stepsTimer) stepsTimer = setTimeout(() => void sendSteps(), STEPS_FLUSH_MS);
    return Promise.resolve();
  };

  // The journal: what the task already lived. Each ask and each step takes the next entry while the handler does what
  // it did before; the first one that differs (another action, another step) ends the replay, and from there on it all
  // runs for real. An ai from before the journal sends only `resume`, the answer to one question.
  const answers = delivery.answers ?? (delivery.resume ? [delivery.resume] : []);
  const memos = delivery.memo ?? [];
  let nextAnswer = 0;
  let nextMemo = 0;
  const replayed = <T>(key: string): { hit: true; value: T } | { hit: false } => {
    const entry = memos[nextMemo];
    if (!entry) return { hit: false };
    if (entry.key !== key) {
      nextMemo = memos.length;
      return { hit: false };
    }
    nextMemo += 1;
    // what the step gave back the first time, as JSON: the caller's own type
    return { hit: true, value: (entry.has ? entry.value : undefined) as T };
  };

  async function once<T>(kind: Step['kind'], key: string, name: string | ((value: T) => string), work: () => Promise<T>, read: (value: T) => Partial<Step>): Promise<T> {
    const memo = replayed<T>(`${kind}:${key}`);
    if (memo.hit) return memo.value;
    const started = Date.now();
    const at = started - began;
    try {
      const value = await work();
      const kept = memoOf(value);
      await report({ kind, name: typeof name === 'string' ? name : name(value), ms: Date.now() - started, at, ...read(value), ...(kept ? { memo: { key: `${kind}:${key}`, ...kept } } : {}) });
      return value;
    } catch (error) {
      await report({ kind, name: typeof name === 'string' ? name : kind, ms: Date.now() - started, at, ...failedStep(error) });
      throw error;
    }
  }

  const tenant = task.tenant ?? '';
  const thread = task.thread ?? null;
  // parts asked so far in this run, per agent and kind: the same call in the same place gets the same key every run
  const partsSeen = new Map<string, number>();
  return {
    task, tenant, thread, lessons: delivery.lessons.items, trial: task.trial,
    async ask(action, question, extra = {}) {
      const answer = answers[nextAnswer];
      // an answer is this question's only when it was given to the same action, question and data: asked about other
      // data on a re-run (another amount, another account), the earlier yes is not this one's (security audit run-1).
      // An ai from before sends neither question nor data: the action alone decides, as before
      const sameAsked = answer !== undefined && answer.action === action
        && (answer.question === undefined || answer.question === question)
        && (answer.data === undefined || sameJson(answer.data, extra.data ?? null));
      if (answer && sameAsked) {
        nextAnswer += 1;
        return answer;
      }
      // another action than the one answered here: the handler changed its way, so from here on it asks for real
      nextAnswer = answers.length;
      // the steps that led here are in the trace before the task waits
      await sendSteps();
      const { pause } = await call<{ pause: { status: string; answer: Answer | null } }>('POST', `${path}/pause`, { attempt: task.attempt, action, question, ...extra });
      if (pause.status === 'answered' && pause.answer) return pause.answer;
      throw PAUSED;
    },
    stream(text) {
      if (!text) return;
      pending += text;
      if (pending.length >= STREAM_FLUSH_CHARS) void flushNow();
      else if (!flushTimer) flushTimer = setTimeout(() => void flushNow(), STREAM_FLUSH_MS);
    },
    flush: async () => { await Promise.all([flushNow(), sendSteps()]); },
    async progress(data) {
      await call('POST', `${path}/progress`, { attempt: task.attempt, data });
    },
    // a block rides on progress: ai keeps it as one of the task's events, and the panel draws what carries «show»
    async show(block) {
      const data: Json = Object.fromEntries(Object.entries(block).filter((entry): entry is [string, Json] => entry[1] !== undefined));
      await call('POST', `${path}/progress`, { attempt: task.attempt, data: { show: data } });
    },
    async step(step) {
      await report(step);
    },
    track: (kind, name, work, usage) => once(kind, name, name, work, (value) => (usage ? usage(value) : {})),
    model: (work, name) => once('model', name ?? '', (value) => name ?? usageOf(value).model ?? 'model', work, usageOf),
    later: (kind, input, at, key) => once('other', `later:${kind}`, `later ${kind}`, async () => {
      await call('POST', '/agent/tasks', { kind, input, at: new Date(at).toISOString(), ...(key ? { key } : {}), ...(tenant ? { tenant } : {}), ...(thread ? { thread } : {}) }, { idempotent: Boolean(key) });
    }, () => ({})),
    async delegate<T>(agent: string, kind: string, input: Json = null, options: { title?: string; key?: string } = {}): Promise<T> {
      if (task.trial) throw new Error('A trial does nothing real: it cannot hand parts to other agents.');
      const seen = partsSeen.get(`${agent}\u0000${kind}`) ?? 0;
      partsSeen.set(`${agent}\u0000${kind}`, seen + 1);
      const key = partKey(options.key ?? `${agent}.${kind}.${seen + 1}`);
      // asked once (the key); past the owner's number at once, it waits its turn here
      let part: Part;
      for (;;) {
        try {
          part = (await call<{ part: Part }>('POST', `${path}/parts`, { attempt: task.attempt, agent, kind, input, key, ...(options.title ? { title: options.title } : {}) }, { idempotent: true })).part;
          break;
        } catch (error) {
          if (!(error instanceof RateLimitError)) throw error;
          await pause(PART_TURN_MS);
        }
      }
      // then it waits: each ask holds on ai for a while; a part waiting for a person's answer is asked less often
      while (part.status === 'queued' || part.status === 'running' || part.status === 'paused') {
        if (part.status === 'paused') await pause(PART_PAUSED_MS);
        part = (await call<{ part: Part }>('GET', `${path}/parts/${encodeURIComponent(part.id)}${query({ attempt: task.attempt, wait: part.status === 'paused' ? 0 : PART_WAIT_SECONDS })}`)).part;
      }
      if (part.status === 'done') return part.result as T;
      throw new PartError(part.agent || agent, part.id, part.status, part.error);
    },
    files: delivery.files ?? [],
    async file(idOrName) {
      const found = (delivery.files ?? []).find((one) => one.id === idOrName || one.name === idOrName);
      if (!found) throw new Error(`No file «${idOrName}» in this task's session: its files are ${(delivery.files ?? []).map((one) => one.name).join(', ') || 'none'}.`);
      const got = await client.download(`/agent/files/${encodeURIComponent(found.id)}${query({ task: task.id })}`);
      return { data: got.data, type: got.type, name: found.name };
    },
    memory: {
      remember: (scope, text, extra = {}) => once('memory', `remember:${scope}`, 'remember', async () => {
        // without a key each one is a new fact: sent twice it would be two
        const answer = await call<{ kept: boolean; fact: Fact | null; why?: string }>('PUT', '/agent/memory', { task: task.id, scope, text, ...extra }, { idempotent: Boolean(extra.key) });
        if (!answer.kept) console.warn(`memory: ${answer.why ?? 'this fact was not kept'}`);
        return answer.fact;
      }, () => ({})),
      async recall(options) {
        return (await call<{ facts: Fact[] }>('GET', `/agent/memory${query({ ...options, task: task.id })}`)).facts;
      },
      async forget(id) {
        await call('DELETE', `/agent/memory/${encodeURIComponent(id)}${query({ task: task.id })}`);
      },
    },
  };
}
