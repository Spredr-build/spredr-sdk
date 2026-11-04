// What ai answers with, as the SDK hands it back.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'canceled';

/** One kind of task: what goes in, what comes out. */
export interface Kind {
  input: unknown;
  output: unknown;
}

/** An agent's kinds by name. Name none and any kind goes: JSON in, and a result as free as fetch's json(); take them
 *  from the agent (KindsOf) and TypeScript checks each name, its input and its result. */
export type Kinds = { [name: string]: Kind };
// `any` on purpose: the untyped result, the way fetch's json() is; KindsOf types it exactly
export type AnyKinds = { [name: string]: { input: Json; output: any } };

export interface Task<Result = Json> {
  id: string;
  agent: string;
  kind: string;
  status: TaskStatus;
  input: Json;
  result: Result | null;
  error: string;
  attempt: number;
  by: 'owner' | 'caller' | 'schedule' | 'hook' | 'agent' | 'trial' | 'judge';
  key: string | null;
  thread: string | null;
  /** Whom the agent worked for in it ("" is no one in particular). */
  tenant: string;
  trial: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskEvent {
  seq: number;
  type: string;
  at: string;
  data: Json;
}

export interface Pause {
  id: string;
  task: string;
  /** Its task's tenant: whose question it is. */
  tenant: string;
  action: string;
  question: string;
  options: string[] | null;
  data: Json;
  status: 'open' | 'answered' | 'canceled';
  answer: Answer | null;
  answeredBy: string;
  auto: boolean;
  createdAt: string;
  answeredAt: string | null;
}

export interface Answer {
  yes: boolean;
  /** What to do instead, when the person changed it. */
  value?: Json;
  note?: string;
}

export interface Fact {
  id: string;
  tenant: string;
  scope: string;
  key: string | null;
  text: string;
  data: Json;
  updatedAt: string;
}

/** The service's redeploy after its keys changed: asked for, not asked for, or refused by spredr (and why). The agent
 *  is made, or its new key taken, either way. */
export type Redeploy = { status: 'started' | 'skipped' } | { status: 'failed'; error: string };

export interface AgentInfo {
  id: string;
  name: string;
  service: string;
  url: string;
  state: 'new' | 'awake' | 'waking' | 'asleep';
  description: string;
  tasks: { kind: string; description: string }[];
  actions: { name: string; neverAuto: boolean }[];
  /** Quiet minutes before it sleeps, null never: the owner's choice when they made one, else what it declared. */
  sleepAfterMinutes: number | null;
  /** Whether that is the owner's choice (the panel's «Dormir») rather than its own. */
  sleepChosen?: boolean;
  lessonsVersion: number;
  tools?: { name: string; description: string; asks: boolean }[];
  limits?: Limits;
}

export interface Freedom {
  action: string;
  tenant: string;
  level: 'ask' | 'auto';
  earned: boolean;
  neverAuto: boolean;
  streak: number;
  approved: number;
  edited: number;
  rejected: number;
  undone: number;
}

export interface Lesson {
  id: string;
  tenant: string;
  text: string;
  why: string;
  sources: string[];
  by: string;
  status: 'proposed' | 'accepted' | 'refused' | 'retired';
}

export interface LessonVersion {
  version: number;
  lessons: string[];
  status: 'trial' | 'live' | 'superseded' | 'failed' | 'discarded';
  trial: { total: number; done: number; passed: number };
}

export interface Feedback {
  seq: number;
  task: string;
  verdict: 'good' | 'bad';
  correction: Json;
  note: string;
  by: string;
  at: string;
}

export interface AskOptions {
  /** Your own key for this task: asking twice with the same key is the same task. */
  key?: string;
  /** Seconds to wait for the outcome (up to 60). */
  wait?: number;
  /** When to start (a Date or ISO time); absent: now. */
  at?: Date | string;
  /** The conversation it belongs to (a customer, a ticket): tasks with the same thread read as one. */
  thread?: string;
  /** Whom the agent works for in it (a user, an account, a team, a business): its memory, freedom, lessons and caps are that tenant's.
   *  A tenant session (`caller.for(tenant)`) sets it for you. */
  tenant?: string;
}

/** One step inside a task: a model call, a tool, a memory read. Its trace and its costs come from these. */
export interface Step {
  kind: 'model' | 'tool' | 'memory' | 'other';
  name: string;
  ms: number;
  at?: number;
  detail?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  ok?: boolean;
}

export interface Summary {
  hours: number;
  tasks: number;
  done: number;
  failed: number;
  failRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  tokens: number;
  costUsd: number;
  perHour: number[];
  failedPerHour: number[];
  tools: { name: string; uses: number }[];
  freedom: { alone: number; asked: number; undone: number };
}

export interface Thread {
  thread: string;
  tasks: number;
  lastAt: string;
  lastTask: string;
}

export interface Limits {
  /** Actions it may take alone in a day; past it, its free actions ask again. null: no limit. */
  autoPerDay?: number | null;
  /** What its model calls may cost in a day (from the steps it reports); past it, new tasks are refused until tomorrow. null: no limit. */
  spendPerDayUsd?: number | null;
  /** Quiet minutes before it sleeps, over what it declares: 0 never, 5 to 1440; null leaves it to the agent. */
  sleepAfterMinutes?: number | null;
  /** Days its finished tasks are kept: 7, 30, 60, 90, 365 or 1825, never past what the plan keeps; null: the plan's. */
  keepDays?: 7 | 30 | 60 | 90 | 365 | 1825 | null;
  /** Days a fact may go unchanged before it is forgotten: 30, 90, 180 or 365; null: never by itself. */
  forgetAfterDays?: 30 | 90 | 180 | 365 | null;
}

/** How full an agent's memory is: what its facts hold of what its plan gives it, in bytes. warn from 80 %, full from
 *  95 % (the next fact may not fit: not kept, the task goes on). */
/** What a task's stream gives, in order: pieces of its live answer, its other events (steps, progress, a question), and
 *  last the task as it finished, paused or failed. */
export type StreamEvent = { type: 'delta'; text: string; seq: number } | { type: 'event'; event: TaskEvent } | { type: 'end'; task: Task };

/** A file in an agent's session (a thread, for one tenant): what a caller left for the agent's code to read. */
export interface SessionFile {
  id: string;
  name: string;
  type: string;
  bytes: number;
  thread?: string;
  tenant?: string;
  updatedAt?: string;
}

export interface MemoryUse {
  usedBytes: number;
  maxBytes: number;
  share: number;
  warn: boolean;
  full: boolean;
  forgetAfterDays: number | null;
}

/** Where an agent's traces go: an OTLP/HTTP endpoint and the names of its headers (their values never come back). */
export interface Traces {
  endpoint: string;
  headers: string[];
  withContent: boolean;
}

/** What one tenant may use, on top of the agent's own caps; null is no cap. */
export interface TenantLimits {
  /** Actions it may take alone a day for this tenant; past it, they ask again until tomorrow. */
  autoPerDay?: number | null;
  /** Model spend a day for this tenant; past it, its new tasks are refused until tomorrow (the others go on). */
  spendPerDayUsd?: number | null;
  /** Facts it may hold of the agent's memory, which all its tenants share. */
  facts?: number | null;
}

/** What one tenant used in a while: its tasks and what their model calls cost. */
export interface TenantUsage {
  tenant: string;
  tasks: number;
  done: number;
  failed: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  lastAt: string | null;
}

export interface TenantInfo {
  tenant: string;
  /** Its caps as they apply: its own, or every tenant's. */
  caps: Required<TenantLimits>;
  ownCaps: boolean;
  today: TenantUsage;
  month: TenantUsage;
  facts: number;
  openQuestions: number;
}
