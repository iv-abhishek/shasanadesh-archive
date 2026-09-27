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
 * Usage: npm run classify:model [-- --limit 50] [-- --all]   (--all: every order, not only low confidence)
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
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
- B: useful in context — guidelines for one scheme, notifications, corrigenda, time-bound campaigns,
  or when unsure.
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
  if (!process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
    throw new Error("LLM_BASE_URL and LLM_MODEL must be set (see .env.example).");
  }

  const rules = await readJsonl<{ sourceId: string; confidence: string; subject: string | null; department: string | null; override?: unknown }>(classificationPath);
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
    .slice(0, limit);

  let extraBody: Record<string, unknown> = {};
  try {
    extraBody = process.env.LLM_EXTRA_BODY?.trim() ? JSON.parse(process.env.LLM_EXTRA_BODY) : {};
  } catch { /* ignored, as in the API */ }

  const openai = new OpenAI({ baseURL: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY || "local", timeout: 120_000 });
  await mkdir(path.dirname(outputPath), { recursive: true });
  console.log(`Model classification: ${todo.length} order(s) with ${process.env.LLM_MODEL}`);

  let ok = 0;
  let failed = 0;
  for (const [index, item] of todo.entries()) {
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
        model: process.env.LLM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 120,
        ...extraBody,
      } as Parameters<typeof openai.chat.completions.create>[0]) as OpenAI.Chat.Completions.ChatCompletion;
      const parsed = parseModelReply(response.choices[0]?.message?.content ?? "");
      if (!parsed) throw new Error("unusable reply");
      const record: ModelClassification = {
        sourceId: item.sourceId,
        ...parsed,
        model: process.env.LLM_MODEL,
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
  }

  console.log(`Done: ${ok} classified, ${failed} skipped. Output: ${path.relative(root, outputPath)}`);
  console.log("Next: npm run classify:orders && npm run db:load");
}

if (process.argv[1]?.endsWith("model-pass.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
