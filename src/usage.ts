// What a model call used, read from its answer, so ctx.model() reports tokens with no reader written by hand. It knows
// the shapes the common clients answer with; any other answer is still timed, just without tokens.
//   Anthropic Messages      { model, usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } }
//   OpenAI Responses        { model, usage: { input_tokens, output_tokens, input_tokens_details: { cached_tokens } } }
//   OpenAI Chat Completions { model, usage: { prompt_tokens, completion_tokens, prompt_tokens_details: { cached_tokens } } }
//   Vercel AI SDK           { usage: { inputTokens, outputTokens, cachedInputTokens } | { promptTokens, completionTokens }, response: { modelId } }
// tokensIn is the input billed in full. Anthropic already leaves the cache out of input_tokens; OpenAI and the AI SDK
// count what came from the cache inside it, so it is taken out here: spredr prices each part at its own rate.

import type { Step } from './types.ts';

type Record_ = { [key: string]: unknown };

const isRecord = (value: unknown): value is Record_ => typeof value === 'object' && value !== null;
const numberAt = (from: Record_, ...names: string[]): number | undefined => {
  for (const name of names) {
    const value = from[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
};

/** The model and its tokens, as far as the answer tells them. */
export function usageOf(answer: unknown): Pick<Step, 'model' | 'tokensIn' | 'tokensOut' | 'cacheReadTokens' | 'cacheWriteTokens'> {
  if (!isRecord(answer)) return {};
  const response = isRecord(answer.response) ? answer.response : {};
  const model = typeof answer.model === 'string' ? answer.model : typeof response.modelId === 'string' ? response.modelId : undefined;
  const usage = isRecord(answer.usage) ? answer.usage : {};
  const input = numberAt(usage, 'input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens');
  const tokensOut = numberAt(usage, 'output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens');
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  // inside the input count (OpenAI, the AI SDK) or beside it (Anthropic)
  const cachedInside = numberAt(details, 'cached_tokens') ?? numberAt(usage, 'cachedInputTokens');
  const cacheRead = cachedInside ?? numberAt(usage, 'cache_read_input_tokens');
  const cacheWrite = numberAt(usage, 'cache_creation_input_tokens');
  const tokensIn = input === undefined ? undefined : Math.max(0, input - (cachedInside ?? 0));
  return {
    ...(model ? { model } : {}), ...(tokensIn === undefined ? {} : { tokensIn }), ...(tokensOut === undefined ? {} : { tokensOut }),
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}), ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  };
}
