// A backend linked to one agent: it signs every request with its own key, sees only the tasks it asked for, and can
// check that a callback really comes from ai. On spredr its keys are already in its variables.

import { client, type ClientOptions } from './http.ts';
import { aiVerifier, privateKeyOf, type Incoming } from './sign.ts';
import { Tasks } from './tasks.ts';
import type { AnyKinds, Kinds, Task } from './types.ts';

export interface CallerOptions extends ClientOptions {
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
}

export interface Callback {
  event: 'task.done' | 'task.failed' | 'task.paused' | 'task.canceled';
  task: Task;
}

function need(value: string | undefined, name: string): string {
  const found = value || process.env[name];
  if (!found) throw new Error(`${name} is not set: link this backend to its agent in spredr (it writes the variables), or pass the options.`);
  return found;
}

/** A backend linked to one agent. With no options it reads the variables spredr writes into a linked service; give it
 *  the agent's kinds (`new Caller<KindsOf<typeof assistant>>()`) and TypeScript checks every name, input and result. */
export class Caller<K extends Kinds = AnyKinds> extends Tasks<K> {
  #id: string;
  #verify: ((request: Incoming) => boolean) | null;

  constructor(options: Partial<CallerOptions> = {}) {
    const { id, key, agent, ai, aiKey, ...clientOptions } = options;
    super(client(need(ai, 'SPREDR_AI_URL'), { from: need(id, 'SPREDR_CALLER_ID'), key: privateKeyOf(need(key, 'SPREDR_CALLER_KEY')) }, clientOptions), need(agent, 'SPREDR_AGENT'));
    this.#id = need(id, 'SPREDR_CALLER_ID');
    const checkWith = aiKey || process.env.SPREDR_AI_KEY;
    this.#verify = checkWith ? aiVerifier(checkWith) : null;
  }

  /** The same as `new Caller(overrides)`: from the variables spredr writes into a linked service. */
  static fromEnv<K extends Kinds = AnyKinds>(overrides: Partial<CallerOptions> = {}): Caller<K> {
    return new Caller<K>(overrides);
  }

  /** The callback, when it really comes from ai (signed, recent, once); null otherwise. Give it the raw body. */
  callback(request: Incoming): Callback | null {
    if (!this.#verify) throw new Error('Pass aiKey (SPREDR_AI_KEY) to check callbacks.');
    if (!this.#verify(request)) return null;
    const text = typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !('event' in parsed) || !('task' in parsed)) return null;
    // signed by ai, but for another caller: someone forwarded a callback ai sent them
    const to = 'to' in parsed && typeof parsed.to === 'object' && parsed.to !== null && 'caller' in parsed.to ? parsed.to.caller : undefined;
    if (to !== undefined && to !== this.#id) return null;
    // signed by ai: its shape is ai's own
    return parsed as Callback;
  }
}
