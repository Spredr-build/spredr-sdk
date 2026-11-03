// What a model call used, read from its answer, so ctx.model() reports tokens with no reader written by hand. It knows
// the shapes the common clients answer with; any other answer is still timed, just without tokens.
//   Anthropic Messages, OpenAI Responses   { model, usage: { input_tokens, output_tokens } }
//   OpenAI Chat Completions                { model, usage: { prompt_tokens, completion_tokens } }
//   Vercel AI SDK (generateText)           { usage: { inputTokens, outputTokens } | { promptTokens, completionTokens }, response: { modelId } }

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
export function usageOf(answer: unknown): Pick<Step, 'model' | 'tokensIn' | 'tokensOut'> {
  if (!isRecord(answer)) return {};
  const response = isRecord(answer.response) ? answer.response : {};
  const model = typeof answer.model === 'string' ? answer.model : typeof response.modelId === 'string' ? response.modelId : undefined;
  const usage = isRecord(answer.usage) ? answer.usage : {};
  const tokensIn = numberAt(usage, 'input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens');
  const tokensOut = numberAt(usage, 'output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens');
  return { ...(model ? { model } : {}), ...(tokensIn === undefined ? {} : { tokensIn }), ...(tokensOut === undefined ? {} : { tokensOut }) };
}
