/**
 * Which model servers write answers (ADR-075).
 *
 * Primary and fallback, both OpenAI-compatible:
 *   - LLM_PROVIDER=openrouter: OpenRouter (key OPENROUTER_API_KEY, model
 *     OPENROUTER_MODEL, default qwen/qwen3.6-35b-a3b), Qwen's thinking turned
 *     off (reasoning.enabled=false). A model server in LLM_BASE_URL/LLM_MODEL
 *     (the local MLX Qwen that dev:all starts) becomes the fallback, unless
 *     LLM_FALLBACK_BASE_URL/LLM_FALLBACK_MODEL name another.
 *   - otherwise: LLM_BASE_URL/LLM_MODEL as before, with an optional
 *     LLM_FALLBACK_BASE_URL/LLM_FALLBACK_MODEL.
 * The fallback is used only when the primary fails before writing anything
 * (unreachable, no credit, rate-limited, server error, timeout), so an answer
 * is never stitched from two models.
 */

import OpenAI from "openai";

export interface LlmTarget {
  name: "primary" | "fallback";
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
  extraBody: Record<string, unknown>;
  headers: Record<string, string>;
  /** Runs on this machine: generation shares the GPU queue with retrieval. */
  local: boolean;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3.6-35b-a3b";

function isLocalUrl(url: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(new URL(url).hostname);
  } catch {
    return true;
  }
}

function extraBodyFrom(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.warn("Ignoring LLM_EXTRA_BODY: not valid JSON.");
    return {};
  }
}

function plainTarget(
  name: LlmTarget["name"],
  baseURL: string | undefined,
  model: string | undefined,
  apiKey: string | undefined,
  extraBody: Record<string, unknown>,
): LlmTarget | null {
  if (!baseURL?.trim() || !model?.trim()) return null;
  const local = isLocalUrl(baseURL);
  return {
    name,
    label: local ? `local ${model}` : `${new URL(baseURL).host} ${model}`,
    baseURL: baseURL.trim(),
    apiKey: apiKey?.trim() || "local-openai-compatible-endpoint",
    model: model.trim(),
    extraBody,
    headers: {},
    local,
  };
}

/** [primary, fallback?] from the environment; empty when nothing is configured. */
export function readLlmTargets(env: NodeJS.ProcessEnv = process.env): LlmTarget[] {
  const extra = extraBodyFrom(env.LLM_EXTRA_BODY);
  const fallbackExplicit = plainTarget(
    "fallback",
    env.LLM_FALLBACK_BASE_URL,
    env.LLM_FALLBACK_MODEL,
    env.LLM_FALLBACK_API_KEY,
    extraBodyFrom(env.LLM_FALLBACK_EXTRA_BODY),
  );

  if ((env.LLM_PROVIDER ?? "").trim().toLowerCase() === "openrouter") {
    const key = env.OPENROUTER_API_KEY?.trim();
    const model = env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
    const primary: LlmTarget | null = key
      ? {
          name: "primary",
          label: `OpenRouter ${model}`,
          baseURL: OPENROUTER_BASE_URL,
          apiKey: key,
          model,
          // Qwen3.x thinks before answering unless told not to (slow, costly).
          extraBody: { reasoning: { enabled: false }, ...extra },
          headers: { "HTTP-Referer": env.APP_PUBLIC_URL?.trim() || "http://localhost:3000", "X-Title": "Sandarbh" },
          local: false,
        }
      : null;
    if (!primary) console.warn("LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is not set: using LLM_BASE_URL only.");
    const fallback =
      fallbackExplicit ?? plainTarget("fallback", env.LLM_BASE_URL, env.LLM_MODEL, env.LLM_API_KEY, {});
    if (!primary) return fallback ? [{ ...fallback, name: "primary" }] : [];
    return fallback ? [primary, fallback] : [primary];
  }

  const primary = plainTarget("primary", env.LLM_BASE_URL, env.LLM_MODEL, env.LLM_API_KEY, extra);
  if (!primary) return fallbackExplicit ? [{ ...fallbackExplicit, name: "primary" }] : [];
  return fallbackExplicit ? [primary, fallbackExplicit] : [primary];
}

const clients = new Map<string, OpenAI>();

export function clientFor(target: LlmTarget, timeoutMs: number): OpenAI {
  const key = `${target.baseURL}|${target.apiKey.slice(-6)}|${timeoutMs}`;
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({
      baseURL: target.baseURL,
      apiKey: target.apiKey,
      timeout: timeoutMs,
      maxRetries: target.local ? 2 : 1,
      defaultHeaders: target.headers,
    });
    clients.set(key, client);
  }
  return client;
}

/** Worth trying the fallback: the primary could not serve the request at all. */
export function shouldFallBack(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true; // includes timeouts
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    return status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
  }
  return false;
}
