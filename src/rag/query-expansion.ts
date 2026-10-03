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
One query in English, one in Hindi (Devanagari). At most 20 words each. Do not answer the question.
Reply with ONLY a JSON object: {"en":"...","hi":"..."}`;

const cache = new Map<string, string[]>();

export function parseExpansions(reply: string, question: string): string[] {
  const match = reply.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const value = JSON.parse(match[0]) as { en?: unknown; hi?: unknown };
    const seen = new Set([question.trim().toLowerCase()]);
    const out: string[] = [];
    for (const raw of [value.en, value.hi]) {
      const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      if (text.length < 4 || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push(text);
    }
    return out;
  } catch {
    return [];
  }
}

export async function expandSearchQuery(question: string, signal?: AbortSignal): Promise<string[]> {
  if (!ENABLED) return [];
  const key = question.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const target = readLlmTargets()[0];
  if (!target || target.local) return [];
  try {
    const response = (await clientFor(target, TIMEOUT_MS).chat.completions.create(
      {
        model: target.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: question.slice(0, 1000) },
        ],
        temperature: 0,
        max_tokens: 160,
        ...target.extraBody,
      } as never,
      { signal },
    )) as { choices: Array<{ message?: { content?: string | null } }> };
    const expansions = parseExpansions(response.choices[0]?.message?.content ?? "", question);
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    cache.set(key, expansions);
    return expansions;
  } catch {
    return [];
  }
}
