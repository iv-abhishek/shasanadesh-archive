/**
 * Search wording for a question (ADR-082).
 *
 * Officers ask in their own words ("service bid experience clause in GFR");
 * the rule is written in the document's words ("prior experience of similar
 * services … 40% / 50% / 80% of the estimated cost", Manual for Procurement
 * of Non-Consultancy Services). One short model call turns the question into
 * two search queries in official wording, English and Hindi. They only widen
 * the candidate pages; the reranker still scores pages against the officer's
 * own question, and the answer is still written only from cited pages.
 *
 * Hosted model only (a local 8B model would add ~10 s); off with
 * RAG_QUERY_EXPANSION=0. Failures and timeouts return no expansions.
 */
import { clientFor, readLlmTargets } from "./llm-targets.js";

const ENABLED = process.env.RAG_QUERY_EXPANSION !== "0";
const TIMEOUT_MS = Number.parseInt(process.env.RAG_QUERY_EXPANSION_TIMEOUT_MS ?? "6000", 10) || 6000;

const SYSTEM_PROMPT = `You help search an archive of Uttar Pradesh government orders (शासनादेश) and Government of India rules and manuals (GFR, procurement manuals, Financial Handbook, service rules, GeM).
Rewrite the user's question as two short search queries that use the exact words such documents use: the formal name of the rule, manual or scheme, and the technical terms of the provision (for example "leave encashment" rather than "money for unused leave").
Service matters of Uttar Pradesh government servants (leave, pay, pension, allowances) are in the Financial Handbook (वित्तीय नियम संग्रह / वित्तीय हस्तपुस्तिका) and later government orders; procurement is in GFR 2017 and the Manuals for Procurement of Goods, Works, Consultancy and Non-Consultancy Services.
One query in English, one in Hindi (Devanagari). At most 20 words each. Correct obvious misspellings.
Also write "passage": two or three sentences in English worded the way the rule book or order itself would state the provision (an approximate draft is fine; it is only used to find the real page and is never shown).
Also write "corrected": the user's question with spelling, typing and grammar mistakes fixed, as one clear sentence in the SAME language and script, with the same meaning. Keep every name, number, date and GO number exactly; do not add facts. If the question is already correct, repeat it unchanged.
Reply with ONLY a JSON object: {"corrected":"...","en":"...","hi":"...","passage":"..."}`;

export interface SearchPlan {
  /** The question with typos and grammar fixed; null when unchanged or unsafe. */
  corrected: string | null;
  /** Extra search wordings (English, Hindi, rule-style passage). */
  expansions: string[];
}

const NO_PLAN: SearchPlan = { corrected: null, expansions: [] };
const cache = new Map<string, SearchPlan>();

function digitsOf(text: string): string[] {
  return (text.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).match(/\d+/g) ?? []).sort();
}

/**
 * The corrected question, if it is a real correction and still the same
 * question: same numbers, similar length, and actually different.
 */
export function acceptCorrection(question: string, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const corrected = raw.replace(/\s+/g, " ").trim();
  const original = question.replace(/\s+/g, " ").trim();
  if (!corrected || corrected.toLowerCase() === original.toLowerCase()) return null;
  if (corrected.length > original.length * 1.8 + 20 || corrected.length < original.length * 0.5) return null;
  if (digitsOf(corrected).join(",") !== digitsOf(original).join(",")) return null;
  const hindi = (text: string) => /[\u0900-\u097F]/.test(text);
  if (hindi(original) !== hindi(corrected)) return null;
  return corrected;
}

export function parsePlan(reply: string, question: string): SearchPlan {
  const match = reply.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!match) return NO_PLAN;
  try {
    const value = JSON.parse(match[0]) as { corrected?: unknown };
    return { corrected: acceptCorrection(question, value.corrected), expansions: parseExpansions(reply, question) };
  } catch {
    return NO_PLAN;
  }
}

export function parseExpansions(reply: string, question: string): string[] {
  const match = reply.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const value = JSON.parse(match[0]) as { en?: unknown; hi?: unknown; passage?: unknown };
    const seen = new Set([question.trim().toLowerCase()]);
    const out: string[] = [];
    // The passage finds pages by meaning (the rule's own wording, e.g.
    // "interest-bearing mobilisation advance … against a bank guarantee").
    for (const [raw, limit] of [[value.en, 200], [value.hi, 200], [value.passage, 600]] as const) {
      const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, limit) : "";
      if (text.length < 4 || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push(text);
    }
    return out;
  } catch {
    return [];
  }
}

export async function expandSearchQuery(question: string, signal?: AbortSignal): Promise<SearchPlan> {
  if (!ENABLED) return NO_PLAN;
  const key = question.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const target = readLlmTargets()[0];
  if (!target || target.local) return NO_PLAN;
  try {
    const response = (await clientFor(target, TIMEOUT_MS).chat.completions.create(
      {
        model: target.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: question.slice(0, 1000) },
        ],
        temperature: 0,
        max_tokens: 420,
        ...target.extraBody,
      } as never,
      { signal },
    )) as { choices: Array<{ message?: { content?: string | null } }> };
    const plan = parsePlan(response.choices[0]?.message?.content ?? "", question);
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    cache.set(key, plan);
    return plan;
  } catch {
    return NO_PLAN;
  }
}
