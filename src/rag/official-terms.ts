/**
 * Pipeline stage: retrieval — official Hindi/English terms (ADR-104)
 *
 * Purpose:
 *   The keyword half of search only sees the words of the question. An English
 *   question ("earned leave limit") misses Hindi orders that say "उपार्जित
 *   अवकाश", and an everyday Hindi wording ("अर्जित छुट्टी") misses the official
 *   one. A short reviewed glossary (datasets/glossary/official-terms.json) adds
 *   the other side's official terms to the search text. The answer prompt still
 *   sees the officer's own question.
 *
 * Invariants:
 *   - at most 4 terms are added; nothing is added when the question already has them
 *   - English terms match whole words, case-insensitive; Hindi terms match as written
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface TermEntry {
  en: string[];
  hi: string[];
  hiAlso: string[];
}

let cached: TermEntry[] | null = null;

export function loadTerms(file = path.resolve("datasets/glossary/official-terms.json")): TermEntry[] {
  if (cached) return cached;
  try {
    cached = (JSON.parse(readFileSync(file, "utf8")) as { terms: TermEntry[] }).terms;
  } catch {
    cached = [];
  }
  return cached;
}

function hasEnglish(text: string, term: string): boolean {
  return new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(text);
}

/** Official terms in the other language (and the official Hindi for everyday Hindi) that the question lacks. */
export function officialTermsFor(question: string, terms = loadTerms()): string[] {
  const text = question.normalize("NFC");
  const added: string[] = [];
  for (const entry of terms) {
    const english = entry.en.some((term) => hasEnglish(text, term));
    const officialHindi = entry.hi.some((term) => text.includes(term));
    const everydayHindi = entry.hiAlso.some((term) => text.includes(term));
    if (english && !officialHindi) added.push(entry.hi[0]);
    if ((officialHindi || everydayHindi) && !english) added.push(entry.en[0]);
    if (everydayHindi && !officialHindi) added.push(entry.hi[0]);
  }
  return [...new Set(added)].slice(0, 4);
}

/** The search text: the question plus the official terms it lacks. */
export function withOfficialTerms(question: string, terms = loadTerms()): string {
  const extra = officialTermsFor(question, terms);
  return extra.length ? `${question} (${extra.join("; ")})` : question;
}
