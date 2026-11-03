// @spredr/sdk: agents on spredr from three sides.
//   Spredr  an owner, with their token: agents, callers, schedules, hooks, memory, freedom, lessons
//   Caller  a backend linked to one agent: ask for tasks, follow them, answer pauses, check callbacks
//   Agent   the agent itself: take tasks, ask before acting, remember, learn

export { Agent, type AgentOptions, type Context, type Delivery, type Handler, type KindsOf, type Manifest } from './agent.ts';
export { Caller, type Callback, type CallerOptions } from './caller.ts';
export {
  AuthenticationError, BadRequestError, ConflictError, ConnectionError, InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError,
  SpredrError, TaskError, TimeoutError,
} from './errors.ts';
export type { CallOptions, ClientOptions } from './http.ts';
export { DEFAULT_AI_URL, OwnedAgent, Spredr, type SpredrOptions } from './owner.ts';
export type { InferInput, InferOutput, StandardSchemaV1 } from './schema.ts';
export { aiVerifier, newKeys, type Incoming } from './sign.ts';
export { Tasks } from './tasks.ts';
export type * from './types.ts';
