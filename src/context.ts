// What a handler gets besides its input: the task, its lessons, and the way to ask, remember, report steps and schedule
// more work. Every call goes to ai signed as the agent, under the task's attempt.
//
// A task works for one tenant (ctx.tenant: a user, an account, a team, a business; "" when no one in particular). Its memory calls name the
// task, and ai takes the tenant from it: whatever the model is talked into, a task reaches its own tenant's memory and
// no other's. A task it schedules (ctx.later) is for the same tenant and thread.

import type { Client } from './http.ts';
import { query } from './http.ts';
import type { Answer, Fact, Json, Step, Task } from './types.ts';
import { usageOf } from './usage.ts';

export interface Delivery {
  task: { id: string; kind: string; input: Json; attempt: number; by: Task['by']; trial: boolean; judges: string | null; createdAt: string; tenant?: string; thread?: string | null };
  /** The last answer only: what an ai from before the journal sends. */
  resume: (Answer & { pause: string; action: string }) | null;
  /** Every answer the task's questions got, in the order asked (free ones too). */
  answers?: (Answer & { pause: string; action: string; auto?: boolean })[];
  /** What each finished step gave back, in order: `key` is the step as the handler named it. */
  memo?: { key: string; has: boolean; value: Json }[];
  lessons: { version: number; items: string[] };
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
  /** Reports one step it took (a model call, a tool): its trace and its costs come from these. */
  step(step: Step): Promise<void>;
  /** Runs `work`, times it, and reports it as a step (failed when it throws). Tokens and cost from what it returns, if
   *  `usage` reads them. Done once per task: when the task runs again (after a question, a retry) it gives back what
   *  `work` gave the first time, as JSON, without running it. Put side effects here so they never happen twice. */
  track<T>(kind: Step['kind'], name: string, work: () => Promise<T>, usage?: (value: T) => Pick<Step, 'model' | 'tokensIn' | 'tokensOut' | 'costUsd' | 'detail'>): Promise<T>;
  /** A model call, timed and reported with its model and tokens read from the answer (Claude, OpenAI, the AI SDK):
   *  `await ctx.model(() => claude.messages.create({ … }))`. `name` defaults to the model. Done once per task, as track. */
  model<T>(work: () => Promise<T>, name?: string): Promise<T>;
  /** A task for later (a reminder, a follow-up), for the same tenant and thread. Done once per task, as track. */
  later(kind: string, input: Json, at: Date | string, key?: string): Promise<void>;
  /** This tenant's memory (this task's): the agent's room is shared by all its tenants, each fact is one tenant's. */
  memory: {
    /** Done once per task, as track. */
    remember(scope: string, text: string, extra?: { key?: string; data?: Json }): Promise<Fact>;
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

export function contextFor(client: Client, delivery: Delivery): Context {
  const { task } = delivery;
  const call = client.call.bind(client);
  const began = Date.now();
  const path = `/agent/tasks/${task.id}`;
  const report = (step: Step & { memo?: { key: string; value?: Json } }): Promise<unknown> => call('POST', `${path}/steps`, { attempt: task.attempt, steps: [step] }).catch(() => undefined);

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
  return {
    task, tenant, thread, lessons: delivery.lessons.items, trial: task.trial,
    async ask(action, question, extra = {}) {
      const answer = answers[nextAnswer];
      if (answer && answer.action === action) {
        nextAnswer += 1;
        return answer;
      }
      // another action than the one answered here: the handler changed its way, so from here on it asks for real
      nextAnswer = answers.length;
      const { pause } = await call<{ pause: { status: string; answer: Answer | null } }>('POST', `${path}/pause`, { attempt: task.attempt, action, question, ...extra });
      if (pause.status === 'answered' && pause.answer) return pause.answer;
      throw PAUSED;
    },
    async progress(data) {
      await call('POST', `${path}/progress`, { attempt: task.attempt, data });
    },
    async step(step) {
      await call('POST', `${path}/steps`, { attempt: task.attempt, steps: [step] });
    },
    track: (kind, name, work, usage) => once(kind, name, name, work, (value) => (usage ? usage(value) : {})),
    model: (work, name) => once('model', name ?? '', (value) => name ?? usageOf(value).model ?? 'model', work, usageOf),
    later: (kind, input, at, key) => once('other', `later:${kind}`, `later ${kind}`, async () => {
      await call('POST', '/agent/tasks', { kind, input, at: new Date(at).toISOString(), ...(key ? { key } : {}), ...(tenant ? { tenant } : {}), ...(thread ? { thread } : {}) }, { idempotent: Boolean(key) });
    }, () => ({})),
    memory: {
      remember: (scope, text, extra = {}) => once('memory', `remember:${scope}`, 'remember', async () =>
        // without a key each one is a new fact: sent twice it would be two
        (await call<{ fact: Fact }>('PUT', '/agent/memory', { task: task.id, scope, text, ...extra }, { idempotent: Boolean(extra.key) })).fact, () => ({})),
      async recall(options) {
        return (await call<{ facts: Fact[] }>('GET', `/agent/memory${query({ ...options, task: task.id })}`)).facts;
      },
      async forget(id) {
        await call('DELETE', `/agent/memory/${id}${query({ task: task.id })}`);
      },
    },
  };
}
