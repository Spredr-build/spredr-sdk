// What a handler gets besides its input: the task, its lessons, and the way to ask, remember, report steps and schedule
// more work. Every call goes to ai signed as the agent, under the task's attempt.

import type { Client } from './http.ts';
import { query } from './http.ts';
import type { Answer, Fact, Json, Step, Task } from './types.ts';
import { usageOf } from './usage.ts';

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
  /** A model call, timed and reported with its model and tokens read from the answer (Claude, OpenAI, the AI SDK):
   *  `await ctx.model(() => claude.messages.create({ … }))`. `name` defaults to the model. */
  model<T>(work: () => Promise<T>, name?: string): Promise<T>;
  /** A task for later (a reminder, a follow-up). */
  later(kind: string, input: Json, at: Date | string, key?: string): Promise<void>;
  memory: {
    remember(scope: string, text: string, extra?: { key?: string; data?: Json }): Promise<Fact>;
    recall(options: { scope?: string; q?: string; limit?: number }): Promise<Fact[]>;
    forget(id: string): Promise<void>;
  };
}

/** Thrown inside ask() to stop a task that waits for an answer; the agent catches it. */
export const PAUSED = Symbol('paused');

const failedStep = (error: unknown): Pick<Step, 'ok' | 'detail'> => ({ ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : 'failed' });

export function contextFor(client: Client, delivery: Delivery): Context {
  const { task } = delivery;
  const call = client.call.bind(client);
  const began = Date.now();
  const path = `/agent/tasks/${task.id}`;
  // the answer the task came back with is the answer to one question, the first that asks for its action
  let resume = delivery.resume;
  const report = (step: Step): Promise<unknown> => call('POST', `${path}/steps`, { attempt: task.attempt, steps: [step] }).catch(() => undefined);

  async function timed<T>(kind: Step['kind'], name: string | ((value: T) => string), work: () => Promise<T>, read: (value: T) => Partial<Step>): Promise<T> {
    const started = Date.now();
    const at = started - began;
    try {
      const value = await work();
      await report({ kind, name: typeof name === 'string' ? name : name(value), ms: Date.now() - started, at, ...read(value) });
      return value;
    } catch (error) {
      await report({ kind, name: typeof name === 'string' ? name : kind, ms: Date.now() - started, at, ...failedStep(error) });
      throw error;
    }
  }

  return {
    task, lessons: delivery.lessons.items, trial: task.trial,
    async ask(action, question, extra = {}) {
      if (resume && resume.action === action) {
        const answer = resume;
        resume = null;
        return answer;
      }
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
    track: (kind, name, work, usage) => timed(kind, name, work, (value) => (usage ? usage(value) : {})),
    model: (work, name) => timed('model', (value) => name ?? usageOf(value).model ?? 'model', work, usageOf),
    async later(kind, input, at, key) {
      await call('POST', '/agent/tasks', { kind, input, at: new Date(at).toISOString(), ...(key ? { key } : {}) }, { idempotent: Boolean(key) });
    },
    memory: {
      async remember(scope, text, extra = {}) {
        // without a key each one is a new fact: sent twice it would be two
        return (await call<{ fact: Fact }>('PUT', '/agent/memory', { scope, text, ...extra }, { idempotent: Boolean(extra.key) })).fact;
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
