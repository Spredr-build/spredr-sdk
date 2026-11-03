// A backend linked to one agent: it signs every request with its own key, sees only the tasks it asked for, and can
// check that a callback really comes from ai. On spredr its keys are already in its variables.

import { client } from './http.ts';
import { aiVerifier, privateKeyOf, type Incoming } from './sign.ts';
import { Tasks } from './tasks.ts';
import type { Task } from './types.ts';

export interface CallerOptions {
  /** cl_…: SPREDR_CALLER_ID. */
  id: string;
  /** Its private key (DER pkcs8, base64): SPREDR_CALLER_KEY. */
  key: string;
  /** The agent it talks to: SPREDR_AGENT. */
  agent: string;
  /** Where ai is: SPREDR_AI_URL. */
  ai: string;
  /** ai's public key, to check callbacks: SPREDR_AI_KEY. */
  aiKey?: string;
  fetch?: typeof fetch;
}

export interface Callback {
  event: 'task.done' | 'task.failed' | 'task.paused' | 'task.canceled';
  task: Task;
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: link this backend to its agent in spredr (it writes the variables), or pass the options.`);
  return value;
}

export class Caller extends Tasks {
  #verify: ((request: Incoming) => boolean) | null;

  constructor(options: CallerOptions) {
    super(client(options.ai, { from: options.id, key: privateKeyOf(options.key) }, options.fetch), options.agent);
    this.#verify = options.aiKey ? aiVerifier(options.aiKey) : null;
  }

  /** From the variables spredr writes into a linked service. */
  static fromEnv(overrides: Partial<CallerOptions> = {}): Caller {
    return new Caller({
      id: overrides.id ?? need('SPREDR_CALLER_ID'), key: overrides.key ?? need('SPREDR_CALLER_KEY'), agent: overrides.agent ?? need('SPREDR_AGENT'),
      ai: overrides.ai ?? need('SPREDR_AI_URL'), aiKey: overrides.aiKey ?? process.env.SPREDR_AI_KEY ?? '', ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    });
  }

  /** The callback, when it really comes from ai (signed, recent, once); null otherwise. Give it the raw body. */
  callback(request: Incoming): Callback | null {
    if (!this.#verify) throw new Error('Pass aiKey (SPREDR_AI_KEY) to check callbacks.');
    if (!this.#verify(request)) return null;
    const text = typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !('event' in parsed) || !('task' in parsed)) return null;
    // signed by ai: its shape is ai's own
    return parsed as Callback;
  }
}
