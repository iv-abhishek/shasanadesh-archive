/**
 * Per-question context (ADR-100): an answer-model override for model
 * comparisons (dev only, RAG_ALLOW_MODEL_OVERRIDE=1) and the tokens and cost
 * the question used, reported in the done event.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ModelUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** As reported by OpenRouter; 0 when the server does not report cost. */
  costUsd: number;
}

export interface RequestContext {
  modelOverride?: string;
  usage: ModelUsage;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function modelOverrideAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAG_ALLOW_MODEL_OVERRIDE === "1";
}

export function newRequestContext(modelOverride?: string): RequestContext {
  return {
    modelOverride: modelOverrideAllowed() && modelOverride ? modelOverride : undefined,
    usage: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 },
  };
}

export function recordUsage(usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null | undefined): void {
  const store = requestContext.getStore();
  if (!store || !usage) return;
  store.usage.calls += 1;
  store.usage.promptTokens += usage.prompt_tokens ?? 0;
  store.usage.completionTokens += usage.completion_tokens ?? 0;
  store.usage.costUsd += usage.cost ?? 0;
}
