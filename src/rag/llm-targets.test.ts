/** Answer model targets (ADR-075, ADR-101). */
import assert from "node:assert/strict";
import { readLlmTargets } from "./llm-targets.js";

const env = {
  LLM_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "sk-or-test",
  OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
  OPENROUTER_FALLBACK_MODEL: "qwen/qwen3.8-flash",
  LLM_BASE_URL: "http://127.0.0.1:8791/v1",
  LLM_MODEL: "mlx-community/Qwen3-8B-4bit",
} as NodeJS.ProcessEnv;

const targets = readLlmTargets(env);
assert.deepEqual(targets.map((t) => t.label), [
  "OpenRouter deepseek/deepseek-v4-flash",
  "OpenRouter qwen/qwen3.8-flash",
  "local mlx-community/Qwen3-8B-4bit",
]);
assert.deepEqual(targets[0].extraBody, { reasoning: { enabled: false } });
assert.equal(targets[1].name, "fallback");
assert.equal(targets[2].local, true);

// A model that must think gets low effort and extra tokens.
const claude = readLlmTargets({ ...env, OPENROUTER_MODEL: "anthropic/claude-sonnet-5.5", OPENROUTER_FALLBACK_MODEL: "" });
assert.deepEqual(claude[0].extraBody, { reasoning: { effort: "low", exclude: true } });
assert.equal(claude[0].extraTokens, 1500);
assert.equal(claude.length, 2, "no hosted fallback when unset");

// Same model twice is not a fallback.
assert.equal(readLlmTargets({ ...env, OPENROUTER_FALLBACK_MODEL: "deepseek/deepseek-v4-flash" }).length, 2);
console.log("llm target tests passed");
