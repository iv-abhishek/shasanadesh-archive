/**
 * Pipeline stage: classification (pass 2 — model) — npm run classify:model
 *
 * Purpose:
 *   The rules (pass 1) flag orders they are unsure about (confidence "low").
 *   This pass asks the configured generator (LLM_BASE_URL / LLM_MODEL — the
 *   local MLX Qwen or a hosted model) to classify those orders from their
 *   subject, portal category, department and the start of their text, and
 *   stores the result in data/corpus/classification-model.jsonl.
 *   `npm run classify:orders` then prefers: human override > model > rules.
 *
 * Invariants:
 *   - only tier/docType labels are produced; nothing is deleted or rewritten
 *   - answers that are not valid JSON with a known tier/type are discarded
 *   - resumable: orders already in the output (same rules version) are skipped
 *
 * Usage: npm run classify:model [-- --limit 50] [-- --all] [-- --tier B] [-- --concurrency 6]
 *   --all          every order, not only low confidence
 *   --tier B       only orders the rules put in that tier (B: the unsorted middle, ADR-078)
 *   --concurrency  parallel requests (default 6 for a hosted model, 1 for local)
 *
 * The model is the answer model's primary (ADR-075): OpenRouter when
 * LLM_PROVIDER=openrouter, else LLM_BASE_URL / LLM_MODEL.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { clientFor, readLlmTargets } from "../rag/llm-targets.js";
import { RULES_VERSION, normalizeSubject, type DocType, type Tier } from "./rules.js";

const root = process.cwd();
const classificationPath = path.join(root, "data/corpus/classification.jsonl");
const outputPath = path.join(root, "data/corpus/classification-model.jsonl");
const documentsRoot = path.join(root, "data/documents");

export const MODEL_DOC_TYPES: DocType[] = [
  "rules", "policy", "guideline", "clarification", "general-instruction", "scheme-guideline",
  "notification", "corrigendum", "sanction", "case-specific", "reminder", "other",
];

export interface ModelClassification {
  sourceId: string;
  tier: Tier;
  docType: DocType;
  reason: string;
  model: string;
  rulesVersion: string;
  classifiedAt: string;
}

const SYSTEM_PROMPT = `You classify Uttar Pradesh government orders (शासनादेश) for a search assistant used by officials.
Decide whether an order is generally applicable guidance or a routine/individual order.

Tiers:
- A: generally applicable — rules, rule amendments, policies, guidelines, procedures, clarifications,
  or instructions addressed to all departments/officers/employees. Officials cite these in their own letters.
- B: useful in context — notifications, corrigenda, time-bound campaigns, or a scheme detail that
  applies only in some situations. Do not use B as "unsure": an order that sets out how a scheme,
  programme or service works for everyone it covers is A; one about a single case is C.
- An order that amends, supersedes or cancels a rule, policy or guideline is A (officials must see it).
- C: routine or individual — financial/administrative sanctions, release of funds, budget allocations,
  orders about one person (appointment, promotion, ACP, retirement dues, prison release), one company,
  one court case, one building/road/project or one district's works.

Document types: ${MODEL_DOC_TYPES.join(", ")}.

Reply with ONLY a JSON object: {"tier":"A|B|C","docType":"<one type>","reason":"<max 15 words>"}`;

export function parseModelReply(reply: string): { tier: Tier; docType: DocType; reason: string } | null {
  const match = reply.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]) as { tier?: unknown; docType?: unknown; reason?: unknown };
    const tier = String(value.tier ?? "").trim().toUpperCase();
    const docType = String(value.docType ?? "").trim() as DocType;
    if (!["A", "B", "C"].includes(tier) || !MODEL_DOC_TYPES.includes(docType)) return null;
    return { tier: tier as Tier, docType, reason: String(value.reason ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

/** First ~800 characters of the order's text (OCR page 1 preferred), if downloaded. */
async function openingText(sourceId: string): Promise<string | null> {
  const folder = path.join(documentsRoot, sourceId.replaceAll("#", "-"));
  for (const file of ["ocr-selective/page-001.txt", "ocr-pages/page-001.txt", "text.txt"]) {
    const text = await readFile(path.join(folder, file), "utf8").catch(() => null);
    if (text && text.trim()) return normalizeSubject(text).slice(0, 800);
  }
  return null;
}

async function main(): Promise<void> {
  const limitIndex = process.argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : Infinity;
  const all = process.argv.includes("--all");
  const tierIndex = process.argv.indexOf("--tier");
  const onlyTier = tierIndex >= 0 ? String(process.argv[tierIndex + 1] ?? "").toUpperCase() : null;
  const target = readLlmTargets()[0];
  if (!target) {
    throw new Error("No answer model configured: set LLM_PROVIDER=openrouter + OPENROUTER_API_KEY, or LLM_BASE_URL + LLM_MODEL.");
  }
  const concurrencyIndex = process.argv.indexOf("--concurrency");
  const concurrency = Math.max(1, Math.min(16, concurrencyIndex >= 0 ? Number(process.argv[concurrencyIndex + 1]) || 1 : target.local ? 1 : 6));

  const rules = await readJsonl<{ sourceId: string; confidence: string; tier?: string; subject: string | null; department: string | null; override?: unknown }>(classificationPath);
  if (!rules.length) throw new Error("Run npm run classify:orders first.");
  const done = new Set(
    (await readJsonl<ModelClassification>(outputPath))
      .filter((item) => item.rulesVersion === RULES_VERSION)
      .map((item) => item.sourceId),
  );
  const listing = new Map(
    (await readJsonl<{ sourceId: string; category?: string | null; section?: string | null }>(path.join(root, "data/portal-capture/inventory.jsonl")))
      .map((row) => [row.sourceId, row]),
  );

  const todo = rules
    .filter((item) => !item.override && (all || item.confidence === "low") && !done.has(item.sourceId))
    .filter((item) => !onlyTier || item.tier === onlyTier)
    .slice(0, limit);

  const openai = clientFor(target, 120_000);
  await mkdir(path.dirname(outputPath), { recursive: true });
  console.log(`Model classification: ${todo.length} order(s) with ${target.label}, ${concurrency} at a time`);

  let ok = 0;
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let next = 0;
  const startedAt = Date.now();
  const classifyOne = async (index: number, item: (typeof todo)[number]) => {
    const row = listing.get(item.sourceId);
    const text = await openingText(item.sourceId);
    const user = [
      `Subject: ${item.subject ?? "(none)"}`,
      `Department: ${item.department ?? "(none)"}`,
      `Portal category: ${row?.category ?? "(none)"}`,
      `Section: ${row?.section ?? "(none)"}`,
      text ? `Opening text: ${text}` : "Opening text: (not downloaded)",
    ].join("\n");

    try {
      const response = await openai.chat.completions.create({
        model: target.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 120,
        ...target.extraBody,
      } as Parameters<typeof openai.chat.completions.create>[0]) as OpenAI.Chat.Completions.ChatCompletion;
      inputTokens += response.usage?.prompt_tokens ?? 0;
      outputTokens += response.usage?.completion_tokens ?? 0;
      const parsed = parseModelReply(response.choices[0]?.message?.content ?? "");
      if (!parsed) throw new Error("unusable reply");
      const record: ModelClassification = {
        sourceId: item.sourceId,
        ...parsed,
        model: target.model,
        rulesVersion: RULES_VERSION,
        classifiedAt: new Date().toISOString(),
      };
      await appendFile(outputPath, JSON.stringify(record) + "\n", "utf8");
      ok++;
      console.log(`[${index + 1}/${todo.length}] ${item.sourceId} → ${parsed.tier} ${parsed.docType} (${parsed.reason})`);
    } catch (error) {
      failed++;
      console.log(`[${index + 1}/${todo.length}] ${item.sourceId} → skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((ok + failed) % 200 === 0) {
      const minutes = (Date.now() - startedAt) / 60_000;
      const left = todo.length - ok - failed;
      console.log(
        `--- ${ok + failed}/${todo.length} in ${minutes.toFixed(1)} min, about ${((minutes / (ok + failed)) * left).toFixed(0)} min left; ` +
          `tokens so far ${inputTokens} in / ${outputTokens} out`,
      );
    }
  };
  // A few requests at a time; each appends its own line, so a stop loses nothing.
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (next < todo.length) {
        const index = next++;
        await classifyOne(index, todo[index]);
      }
    }),
  );

  console.log(`Done: ${ok} classified, ${failed} skipped. Tokens: ${inputTokens} in / ${outputTokens} out. Output: ${path.relative(root, outputPath)}`);
  console.log("Next: npm run classify:orders && npm run db:load");
}

if (process.argv[1]?.endsWith("model-pass.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
