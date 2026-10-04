/** Model comparison plumbing (ADR-100). */
import assert from "node:assert/strict";
import { reasoningFor } from "./llm-targets.js";
import { newRequestContext, recordUsage, requestContext } from "./request-context.js";

assert.deepEqual(reasoningFor("qwen/qwen3.6-35b-a3b").body, { reasoning: { enabled: false } });
assert.deepEqual(reasoningFor("openai/gpt-5.6-luna").body, { reasoning: { enabled: false } });
assert.equal(reasoningFor("anthropic/claude-sonnet-5.5").extraTokens, 1500);
assert.deepEqual(reasoningFor("google/gemini-3.8-flash").body, { reasoning: { effort: "low", exclude: true } });

delete process.env.RAG_ALLOW_MODEL_OVERRIDE;
assert.equal(newRequestContext("google/gemini-3.8-flash").modelOverride, undefined, "ignored unless allowed");
process.env.RAG_ALLOW_MODEL_OVERRIDE = "1";
const ctx = newRequestContext("google/gemini-3.8-flash");
assert.equal(ctx.modelOverride, "google/gemini-3.8-flash");

requestContext.run(ctx, () => {
  recordUsage({ prompt_tokens: 1000, completion_tokens: 200, cost: 0.0015 });
  recordUsage({ prompt_tokens: 500, completion_tokens: 100, cost: 0.0005 });
});
assert.deepEqual(ctx.usage, { calls: 2, promptTokens: 1500, completionTokens: 300, costUsd: 0.002 });
recordUsage({ prompt_tokens: 1 }); // outside a question: ignored
console.log("model comparison plumbing tests passed");
