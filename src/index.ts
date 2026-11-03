// @spredr/sdk: agents on spredr from three sides.
//   Spredr  an owner, with their token: agents, callers, schedules, hooks, memory, freedom, lessons
//   Caller  a backend linked to one agent: ask for tasks, follow them, answer pauses, check callbacks
//   Agent   the agent itself: take tasks, ask before acting, remember, learn

export { Agent, type AgentOptions, type Context, type Delivery, type Handler, type Manifest } from './agent.ts';
export { Caller, type Callback, type CallerOptions } from './caller.ts';
export { SpredrError } from './http.ts';
export { DEFAULT_AI_URL, OwnedAgent, Spredr, type SpredrOptions } from './owner.ts';
export { aiVerifier, newKeys, type Incoming } from './sign.ts';
export { Tasks } from './tasks.ts';
export type * from './types.ts';
