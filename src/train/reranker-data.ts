/**
 * Pipeline stage: training data for the reranker (ADR-104)
 *
 * Purpose:
 *   Teach Qwen3-Reranker-0.6B what a good page looks like for officers'
 *   questions about UP orders and rulebooks. Three steps, each resumable:
 *
 *     npm run train:questions -- --pages 5000      DeepSeek writes 3 questions per sampled page
 *     npm run train:negatives                       the current search (retrieval service must
 *                                                   be running) supplies look-alike wrong pages
 *     npm run train:export                          train/dev files for the GPU (split by document)
 *
 *   Output in data/train/. The GPU step is train/finetune_reranker.py.
 *
 * Invariants:
 *   - pages come from data/corpus/retrieval-pages.jsonl (canonical variant: the
 *     text search actually scores), so the model learns on what it will see
 *   - documents that eval/rag-cases.json expects are never used, so the eval
 *     stays a fair test
 *   - a wrong page that also answers the question (another copy, an amendment)
 *     is checked by the model and dropped rather than taught as wrong
 *   - train and dev never share a document
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type OpenAI from "openai";
import { clientFor, readLlmTargets, type LlmTarget } from "../rag/llm-targets.js";

const DIR = path.resolve("data/train");
const QUESTIONS = path.join(DIR, "questions.jsonl");
const MINED = path.join(DIR, "mined.jsonl");
const PAGES_FILE = path.resolve("data/corpus/retrieval-pages.jsonl");
const RETRIEVAL = process.env.RETRIEVAL_BASE_URL ?? "http://127.0.0.1:8788";
const MAX_TEXT = 4000; // the retrieval service reranks the first 4,000 characters

interface Page {
  variantId: string;
  sourceId: string;
  pageNumber: number;
  text: string;
}

interface QuestionRow {
  variantId: string;
  sourceId: string;
  pageNumber: number;
  group: string;
  skip?: boolean;
  questions: Array<{ q: string; lang: string; style: string }>;
}

interface MinedRow {
  query: string;
  lang: string;
  style: string;
  sourceId: string;
  pageNumber: number;
  positiveRank: number | null;
  negatives: Array<{ sourceId: string; pageNumber: number; rank: number }>;
  droppedAsAlsoAnswering: number;
}

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
}

function hash(value: string): number {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

/** Which kind of document a source id is (sampling groups). */
export function groupOf(sourceId: string): "rulebook" | "order" | "other" {
  if (/^(core-rules|up-fhb|doe-gfr|gov-cms|msme)-/.test(sourceId)) return "rulebook";
  if (sourceId.includes("#")) return "order";
  return "other";
}

function clean(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Mostly words, not a table of figures or a signature block. */
export function usablePage(text: string): boolean {
  if (text.length < 400) return false;
  const letters = (text.match(/[\p{L}\p{M}]/gu) ?? []).length;
  return letters / text.length >= 0.45;
}

async function readPages(): Promise<Page[]> {
  const pages: Page[] = [];
  const lines = readline.createInterface({ input: createReadStream(PAGES_FILE), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Page & { canonical?: boolean };
    if (row.canonical === false) continue;
    const text = clean(row.text ?? "");
    if (usablePage(text)) pages.push({ variantId: row.variantId, sourceId: row.sourceId, pageNumber: row.pageNumber, text });
  }
  return pages;
}

async function evalSources(): Promise<Set<string>> {
  const raw = JSON.parse(await readFile(path.resolve("eval/rag-cases.json"), "utf8"));
  const cases = (Array.isArray(raw) ? raw : raw.cases) as Array<{ expectedSourceIds?: string[] }>;
  return new Set(cases.flatMap((item) => item.expectedSourceIds ?? []));
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

/** Stratified, deterministic sample: rulebooks 35%, orders 55%, other collections 10%. */
export function samplePages(pages: Page[], total: number, excluded: Set<string>): Page[] {
  const shares = { rulebook: 0.35, order: 0.55, other: 0.1 } as const;
  const perDocument = { rulebook: 8, order: 3, other: 4 } as const;
  const chosen: Page[] = [];
  for (const group of ["rulebook", "order", "other"] as const) {
    const pool = pages
      .filter((page) => groupOf(page.sourceId) === group && !excluded.has(page.sourceId))
      .sort((a, b) => hash(a.variantId) - hash(b.variantId));
    const taken = new Map<string, number>();
    const want = Math.round(total * shares[group]);
    let inGroup = 0;
    for (const page of pool) {
      if (inGroup >= want) break;
      const count = taken.get(page.sourceId) ?? 0;
      if (count >= perDocument[group]) continue;
      taken.set(page.sourceId, count + 1);
      chosen.push(page);
      inGroup++;
    }
  }
  return chosen;
}

const QUESTION_PROMPT = `You write realistic questions that Uttar Pradesh government officers would type into a search assistant.
You are given one page of a government order, rule book or manual. The page text may have broken Hindi characters from PDF extraction; read through them.
Write exactly 3 questions that THIS page answers (fully or with its key fact):
1. "en": a natural English question, as an officer would ask it (not copying the page's sentences).
2. "hi": a natural question in Hindi (Devanagari, correct spelling), as an officer would ask it.
3. "keyword": a short search of 2–6 words, English or Hindi or mixed, as typed in a hurry.
Do not mention "this page", "the document" or "the GO". Use the subject, not the GO number, unless officers would search by number.
If the page has no answerable content (a forwarding list, signatures, an index, a blank form, a table of figures with no headings), return {"skip": true}.
Reply with JSON only: {"skip": false, "questions": [{"q": "...", "lang": "en", "style": "question"}, {"q": "...", "lang": "hi", "style": "question"}, {"q": "...", "lang": "mixed|en|hi", "style": "keyword"}]}`;

const JUDGE_PROMPT = `Question: {q}

Passage:
{p}

Does this passage itself answer the question (state the rule, figure, condition or procedure asked about)? Reply with one word: yes or no.`;

function primaryTarget(): LlmTarget {
  const target = readLlmTargets().find((item) => !item.local);
  if (!target) throw new Error("No hosted model configured (LLM_PROVIDER=openrouter and OPENROUTER_API_KEY in .env).");
  return target;
}

async function complete(openai: OpenAI, target: LlmTarget, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[], maxTokens: number): Promise<string> {
  const response = (await openai.chat.completions.create({
    model: target.model,
    messages,
    temperature: 0.4,
    max_tokens: maxTokens + (target.extraTokens ?? 0),
    ...target.extraBody,
  } as Parameters<typeof openai.chat.completions.create>[0])) as OpenAI.Chat.Completions.ChatCompletion;
  return response.choices[0]?.message?.content ?? "";
}

export function parseQuestions(reply: string): { skip: boolean; questions: QuestionRow["questions"] } | null {
  const json = reply.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { skip?: boolean; questions?: Array<{ q?: string; lang?: string; style?: string }> };
    if (parsed.skip) return { skip: true, questions: [] };
    const questions = (parsed.questions ?? [])
      .filter((item) => typeof item.q === "string" && item.q.trim().length >= 4 && item.q.length <= 300)
      .map((item) => ({ q: item.q!.trim(), lang: item.lang ?? "en", style: item.style ?? "question" }));
    return questions.length ? { skip: false, questions } : null;
  } catch {
    return null;
  }
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

async function questionsStep(): Promise<void> {
  const total = option("--pages", 5000);
  const concurrency = option("--concurrency", 8);
  await mkdir(DIR, { recursive: true });
  const [pages, excluded, done] = await Promise.all([readPages(), evalSources(), readJsonl<QuestionRow>(QUESTIONS)]);
  const finished = new Set(done.map((row) => row.variantId));
  const sample = samplePages(pages, total, excluded).filter((page) => !finished.has(page.variantId));
  console.log(`${pages.length} usable pages · ${excluded.size} eval documents left out · ${finished.size} done · ${sample.length} to ask`);
  const target = primaryTarget();
  const openai = clientFor(target, 90_000);
  let count = 0;
  let failed = 0;
  await pool(sample, concurrency, async (page) => {
    try {
      const reply = await complete(openai, target, [
        { role: "system", content: QUESTION_PROMPT },
        { role: "user", content: page.text.slice(0, 3500) },
      ], 400);
      const parsed = parseQuestions(reply);
      if (!parsed) throw new Error("unusable reply");
      const row: QuestionRow = { variantId: page.variantId, sourceId: page.sourceId, pageNumber: page.pageNumber, group: groupOf(page.sourceId), ...parsed };
      await appendFile(QUESTIONS, JSON.stringify(row) + "\n");
    } catch (error) {
      failed++;
      if (failed <= 5) console.warn(`  ${page.variantId}: ${error instanceof Error ? error.message : error}`);
    }
    if (++count % 100 === 0) console.log(`  ${count}/${sample.length} pages`);
  });
  console.log(`Done: ${count - failed} pages written, ${failed} failed (run again to retry). ${QUESTIONS}`);
}

interface Hit {
  source_id: string;
  page_number: number;
  text: string;
}

async function search(query: string): Promise<Hit[]> {
  const response = await fetch(`${RETRIEVAL}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, top_k: 10, candidate_count: 40, rerank_count: 12, max_evidence_pages: 10, prefer_authority: true, filters: {} }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`retrieval ${response.status}`);
  return ((await response.json()) as { evidence: Hit[] }).evidence;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter((word) => word.length >= 3));
}

export function sharedWords(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

async function negativesStep(): Promise<void> {
  // One search at a time: the local models run on one GPU (the service also serialises them).
  const concurrency = option("--concurrency", 1);
  const rows = (await readJsonl<QuestionRow>(QUESTIONS)).filter((row) => !row.skip);
  const done = new Set((await readJsonl<MinedRow>(MINED)).map((row) => `${row.sourceId}|${row.pageNumber}|${row.query}`));
  const pages = new Map((await readPages()).map((page) => [`${page.sourceId}|${page.pageNumber}`, page.text]));
  const todo = rows.flatMap((row) => row.questions.map((question) => ({ row, question }))).filter(({ row, question }) => !done.has(`${row.sourceId}|${row.pageNumber}|${question.q}`));
  // The search service must answer before hours of work start (5 Oct: every search failed silently).
  const health = await fetch(`${RETRIEVAL}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!health?.ok) {
    throw new Error(`The retrieval service is not answering at ${RETRIEVAL}. Start it (npm run dev:all) and wait for "models ready", then run this again.`);
  }
  console.log(`${todo.length} questions to search (${done.size} done).`);
  const target = primaryTarget();
  const openai = clientFor(target, 60_000);
  let count = 0;
  let failed = 0;
  let failedInARow = 0;
  let stopped = false;
  await pool(todo, concurrency, async ({ row, question }) => {
    if (stopped) return;
    try {
      const positive = pages.get(`${row.sourceId}|${row.pageNumber}`) ?? "";
      const hits = await search(question.q);
      const positiveIndex = hits.findIndex((hit) => hit.source_id === row.sourceId && hit.page_number === row.pageNumber);
      const candidates = hits
        .map((hit, rank) => ({ hit, rank: rank + 1 }))
        .filter(({ hit }) => hit.source_id !== row.sourceId && sharedWords(hit.text, positive) < 0.6);
      // Wrong pages ranked above the right one may in fact also answer: ask.
      let dropped = 0;
      let judged = 0;
      const kept: typeof candidates = [];
      for (const candidate of candidates) {
        const above = positiveIndex < 0 ? candidate.rank <= 2 : candidate.rank <= positiveIndex;
        if (above && judged >= 3) continue; // too uncertain to teach as wrong without a check
        if (above) {
          judged++;
          const verdict = await complete(openai, target, [
            { role: "user", content: JUDGE_PROMPT.replace("{q}", question.q).replace("{p}", candidate.hit.text.slice(0, 2500)) },
          ], 3);
          if (/^\s*yes/i.test(verdict)) {
            dropped++;
            continue;
          }
        }
        kept.push(candidate);
        if (kept.length >= 7) break;
      }
      const mined: MinedRow = {
        query: question.q,
        lang: question.lang,
        style: question.style,
        sourceId: row.sourceId,
        pageNumber: row.pageNumber,
        positiveRank: positiveIndex >= 0 ? positiveIndex + 1 : null,
        negatives: kept.map(({ hit, rank }) => ({ sourceId: hit.source_id, pageNumber: hit.page_number, rank })),
        droppedAsAlsoAnswering: dropped,
      };
      await appendFile(MINED, JSON.stringify(mined) + "\n");
      failedInARow = 0;
    } catch (error) {
      failed++;
      failedInARow++;
      if (failed <= 5) console.warn(`  ${question.q.slice(0, 60)}: ${error instanceof Error ? error.message : error}`);
      if (failedInARow >= 20 && !stopped) {
        stopped = true;
        console.error(`\nStopped: 20 searches in a row failed (last: ${error instanceof Error ? error.message : error}). Is the retrieval service still running? Run again to continue.`);
      }
    }
    if (++count % 200 === 0) console.log(`  ${count}/${todo.length}`);
  });
  console.log(`${stopped ? "Stopped" : "Done"}: ${count - failed} questions mined, ${failed} failed. ${MINED}`);
  if (failed) process.exitCode = 1;
}

/** The reranker instruction exactly as services/retrieval_server.py defines it. */
export function rerankInstruction(source: string): string {
  const block = source.match(/RERANK_INSTRUCTION\s*=\s*\(([\s\S]*?)\n\)/)?.[1];
  if (!block) throw new Error("RERANK_INSTRUCTION not found in services/retrieval_server.py");
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`) as string).join("");
}

async function exportStep(): Promise<void> {
  await writeFile(path.join(DIR, "rerank_instruction.txt"), rerankInstruction(await readFile(path.resolve("services/retrieval_server.py"), "utf8")) + "\n");
  const mined = await readJsonl<MinedRow>(MINED);
  if (!mined.length) throw new Error("data/train/mined.jsonl is empty: run npm run train:negatives (with the retrieval service running) first.");
  const pages = new Map((await readPages()).map((page) => [`${page.sourceId}|${page.pageNumber}`, page.text.slice(0, MAX_TEXT)]));
  const isDev = (sourceId: string) => hash(`dev|${sourceId}`) % 100 < 8;
  const train: string[] = [];
  const dev: string[] = [];
  const ranks: Array<number | null> = [];
  for (const row of mined) {
    const positive = pages.get(`${row.sourceId}|${row.pageNumber}`);
    const negatives = row.negatives.map((item) => pages.get(`${item.sourceId}|${item.pageNumber}`)).filter((text): text is string => Boolean(text));
    if (!positive || negatives.length < 2) continue;
    // A document's pages go to one side only; so do the documents its negatives come from.
    if (isDev(row.sourceId)) {
      dev.push(JSON.stringify({ query: row.query, positive: [positive], negative: negatives, lang: row.lang, style: row.style }));
      ranks.push(row.positiveRank);
    } else if (!row.negatives.some((item) => isDev(item.sourceId))) {
      const record: Record<string, string> = { query: row.query, positive };
      negatives.slice(0, 5).forEach((text, index) => (record[`negative_${index + 1}`] = text));
      for (let index = negatives.length; index < 5; index++) record[`negative_${index + 1}`] = negatives[index % negatives.length];
      train.push(JSON.stringify(record));
    }
  }
  await writeFile(path.join(DIR, "reranker-train.jsonl"), train.join("\n") + "\n");
  await writeFile(path.join(DIR, "reranker-dev.jsonl"), dev.join("\n") + "\n");
  const at1 = ranks.filter((rank) => rank === 1).length;
  const at4 = ranks.filter((rank) => rank !== null && rank <= 4).length;
  const summary = {
    train: train.length,
    dev: dev.length,
    currentSearchOnDev: { rightPageFirst: +(at1 / Math.max(1, ranks.length)).toFixed(3), rightPageInTop4: +(at4 / Math.max(1, ranks.length)).toFixed(3) },
  };
  await writeFile(path.join(DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Copy data/train/reranker-train.jsonl, reranker-dev.jsonl and train/finetune_reranker.py to the GPU machine (docs/GPU_RUNBOOK.md).`);
}

async function main(): Promise<void> {
  const step = process.argv[2];
  if (step === "questions") return questionsStep();
  if (step === "negatives") return negativesStep();
  if (step === "export") return exportStep();
  throw new Error("Usage: reranker-data.ts questions [--pages N] | negatives | export");
}

if (process.argv[1]?.endsWith("reranker-data.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
