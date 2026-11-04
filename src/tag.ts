// Which task the code is working on right now, wherever it is in the call chain, and its id on every line the code
// prints while it works: searching the deployment's logs for a task's id finds what it printed. console's lines carry
// it on their own (`[tsk_…] …`); a logger that writes on its own (pino, winston) can add it with currentTask().

import { AsyncLocalStorage } from 'node:async_hooks';

const working = new AsyncLocalStorage<string>();
const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
let tagged = false;

/** The id of the task the code is working on now, or null outside one: for a logger's own fields, e.g.
 *  `pino({ mixin: () => ({ task: currentTask() }) })`. */
export function currentTask(): string | null {
  return working.getStore() ?? null;
}

/** Runs `work` as the given task: currentTask() says its id all the way down. */
export function asTask<T>(taskId: string, work: () => T): T {
  return working.run(taskId, work);
}

/** From now on, console's lines printed while a task works start with its id. Done once per process. */
export function tagConsole(): void {
  if (tagged) return;
  tagged = true;
  for (const method of METHODS) {
    const print = console[method].bind(console);
    console[method] = (...parts: unknown[]) => {
      const id = working.getStore();
      if (!id) return print(...parts);
      const [first, ...rest] = parts;
      // a format string stays the first argument, with the id in front of it
      return typeof first === 'string' ? print(`[${id}] ${first}`, ...rest) : print(`[${id}]`, ...parts);
    };
  }
}
