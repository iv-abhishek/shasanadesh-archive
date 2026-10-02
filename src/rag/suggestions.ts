/**
 * Follow-up questions under an answer (ADR-065).
 *
 * After an answer is shown, the browser asks POST /api/suggest for up to three
 * short questions a UP/central government official would plausibly ask next,
 * answerable from the same orders. Answers from the text use the model (small
 * budget, after the answer, never blocking it); order lists get deterministic
 * questions about the listed orders; anything that fails falls back to fixed,
 * generally useful questions. Suggestions never contain URLs (Rulebook §1).
 */

import { stripNonGovernmentLinks } from "../lib/public-links.js";

export interface SuggestionSource {
  title?: string | null;
  goNumber?: string | null;
  goDate?: string | null;
  department?: string | null;
}

export interface SuggestionRequest {
  question: string;
  answer: string;
  language: "hi" | "en";
  sources: SuggestionSource[];
  listing?: boolean;
}

const MAX = 3;

export const SUGGESTION_SYSTEM_PROMPT = `
You suggest follow-up questions for an assistant that answers from Uttar Pradesh and Government of India orders, rules and guidelines.
Given the user's question, the answer and the orders it cited, write exactly three short follow-up questions the same official is likely to ask next.
- Each must be answerable from government orders like the ones cited (procedure, eligibility, competent authority, limits, documents required, time limits, later amendments, related orders).
- Each question must make sense on its own: name the subject (the cadre, scheme, service rules or order topic, e.g. "Medical Officers", "PM-KUSUM solar pumps") instead of "this", "the candidate" or "the scheme".
- Write in the requested language only. At most 18 words each. No numbering, no URLs, no invented GO numbers, dates or amounts.
- Do not repeat the original question.
Return only a JSON array of three strings.
`.trim();

export function buildSuggestionMessages(request: SuggestionRequest): Array<{ role: "system" | "user"; content: string }> {
  const cited = request.sources
    .slice(0, 4)
    .map((source) => [source.title, source.department, source.goNumber && `GO ${source.goNumber}`, source.goDate].filter(Boolean).join(" · "))
    .filter(Boolean);
  return [
    { role: "system", content: SUGGESTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `LANGUAGE: ${request.language === "hi" ? "Hindi (Devanagari)" : "English"}`,
        `QUESTION: ${request.question.slice(0, 500)}`,
        `ANSWER: ${request.answer.replace(/\[S\d+ p\.\d+\]/g, "").slice(0, 1200)}`,
        cited.length ? `CITED ORDERS:\n${cited.map((line) => `- ${line}`).join("\n")}` : "CITED ORDERS: none",
      ].join("\n"),
    },
  ];
}

/** Clean the model's reply into at most three usable questions. */
export function parseSuggestions(reply: string, request: Pick<SuggestionRequest, "question" | "language">): string[] {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let items: unknown[] = [];
  const json = /\[[\s\S]*\]/.exec(text);
  if (json) {
    try {
      items = JSON.parse(json[0]);
    } catch {
      items = [];
    }
  }
  // A JSON array the model did not close or got slightly wrong
  // (["…?", "…?",? …): take the quoted strings, else the lines.
  if (!items.length) {
    const quoted = [...text.matchAll(/"((?:[^"\\\n]|\\.){8,})"/g)].map((match) => match[1].replace(/\\"/g, '"'));
    items = quoted.length ? quoted : text.split("\n").map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""));
  }
  return clean(items.filter((item): item is string => typeof item === "string"), request);
}

function clean(items: string[], request: Pick<SuggestionRequest, "question" | "language">): string[] {
  const seen = new Set([normalise(request.question)]);
  const out: string[] = [];
  for (const raw of items) {
    // Leftover JSON punctuation from a malformed array (`"…?",` / `["…`).
    let item = stripNonGovernmentLinks(raw)
      .replace(/^[\s\["'“”,]+|[\s\]"'“”,]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!item || /https?:|www\./i.test(item)) continue;
    if (item.length < 8 || item.length > 140) continue;
    const hindi = /[ऀ-ॿ]/.test(item);
    if (request.language === "hi" && !hindi) continue;
    if (request.language === "en" && hindi && !/[A-Za-z]{3}/.test(item)) continue;
    if (!/[?？]$/.test(item)) item += "?";
    const key = normalise(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length === MAX) break;
  }
  return out;
}

const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const displayDate = (iso: string | null | undefined) =>
  iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : null;

/** Order lists: ask about the orders just listed. */
export function listingSuggestions(request: SuggestionRequest): string[] {
  const items = request.sources
    .filter((source) => source.goNumber)
    .slice(0, 2)
    .map((source) => {
      const date = displayDate(source.goDate);
      return request.language === "hi"
        ? `शासनादेश संख्या ${source.goNumber}${date ? ` दिनांक ${date}` : ""} में क्या निर्देश हैं?`
        : `What does GO ${source.goNumber}${date ? ` dated ${date}` : ""} say?`;
    });
  return clean([...items, ...fallbackSuggestions(request).slice(2)], request);
}

/** When the model is not available: questions that fit almost any order. */
export function fallbackSuggestions(request: Pick<SuggestionRequest, "language" | "question">): string[] {
  const items = request.language === "hi"
    ? ["इसकी प्रक्रिया क्या है?", "सक्षम प्राधिकारी कौन है?", "क्या इस आदेश में बाद में कोई संशोधन हुआ है?"]
    : ["What is the procedure under this order?", "Who is the competent authority?", "Has this order been amended later?"];
  return clean(items, request);
}
