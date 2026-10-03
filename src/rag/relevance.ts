/**
 * Relevance gate between retrieval and generation.
 *
 * Retrieval always returns its top pages, even when none of them is about the
 * question (e.g. "medical officer seniority" searched only inside Agriculture).
 * Passing those pages to the model produced answers like "the evidence does not
 * contain…" with a forced citation, and unrelated source cards. This gate:
 *   - converts reranker scores to a 0–1 relevance (they may be probabilities or
 *     raw logits depending on the model build),
 *   - keeps direct pages at or above the minimum relevance, and neighbour pages
 *     only when the page they sit next to was kept,
 *   - reports the best relevance so the caller can widen the scope or answer
 *     "not found".
 * Relevance here is an ordering/threshold signal only, never factual confidence.
 */

import type { RetrievalEvidence } from "./types.js";
import { findDepartmentEntry } from "../departments/registry.js";

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** Map reranker scores to 0–1. Probabilities pass through; logits get a sigmoid. */
export function toRelevance(scores: number[]): number[] {
  const finite = scores.filter((score) => Number.isFinite(score));
  const probabilities = finite.length > 0 && finite.every((score) => score >= 0 && score <= 1);
  return scores.map((score) =>
    Number.isFinite(score) ? (probabilities ? score : sigmoid(score)) : 0,
  );
}

export interface RelevanceAssessment {
  kept: RetrievalEvidence[];
  dropped: number;
  /** Best relevance among direct pages (0 when there are none). */
  best: number;
}

export function assessRelevance(
  evidence: RetrievalEvidence[],
  minRelevance: number,
): RelevanceAssessment {
  const direct = evidence.filter((item) => item.retrieval_role !== "neighbor");
  const relevance = toRelevance(direct.map((item) => item.rerank_score_raw));
  const keptDirect = new Set<RetrievalEvidence>();
  let best = 0;

  direct.forEach((item, index) => {
    best = Math.max(best, relevance[index]);
    if (relevance[index] >= minRelevance) keptDirect.add(item);
  });

  const keptPages = new Set(
    [...keptDirect].map((item) => `${item.source_id}#${item.page_number}`),
  );

  const kept = evidence.filter((item) => {
    if (item.retrieval_role !== "neighbor") return keptDirect.has(item);
    // A neighbour is kept only with the page that pulled it in.
    return keptPages.has(`${item.source_id}#${item.anchor_page_number ?? -1}`);
  });

  return { kept, dropped: evidence.length - kept.length, best };
}

/**
 * True when any kept page comes from one of the officer's own departments
 * (any spelling). Rulebook and central pages pass every department filter, so
 * a scoped search can "find" a Handbook page that mentions medical officers in
 * passing while the officer's departments had nothing (2 Oct 2026); the caller
 * then also searches all departments.
 */
export function hasEvidenceFromDepartments(evidence: RetrievalEvidence[], departments: string[]): boolean {
  const clean = (text: string) => text.replace(/[\u200c\u200d]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const names = new Set(departments.map(clean));
  const ids = new Set(
    departments.map((name) => findDepartmentEntry(name)?.id).filter((id): id is number => id !== undefined),
  );
  return evidence.some((item) => {
    if (!item.department) return false;
    if (names.has(clean(item.department))) return true;
    const id = findDepartmentEntry(item.department)?.id;
    return id !== undefined && ids.has(id);
  });
}

/** The model's agreed reply when none of the evidence answers the question. */
export const NO_ANSWER_TOKEN = "NO_ANSWER_IN_EVIDENCE";

export function isNoAnswer(draft: string): boolean {
  return draft.includes(NO_ANSWER_TOKEN) && draft.replace(NO_ANSWER_TOKEN, "").trim().length < 160;
}

// "The provided evidence does not contain …", "आदेशों में … कोई जानकारी नहीं दी
// गई है": the model saying "not found" in prose instead of NO_ANSWER_IN_EVIDENCE.
const NON_ANSWER_SENTENCE = new RegExp(
  [
    String.raw`\b(?:provided|given|retrieved|available|cited)\s+(?:evidence|documents?|pages?|orders?|excerpts?)\b[^.]*\b(?:do(?:es)?\s+not|doesn't|don't)\b`,
    String.raw`\b(?:evidence|documents?|pages?|orders?|excerpts?)\s+(?:do(?:es)?\s+not|doesn't|don't)\s+(?:contain|address|cover|mention|provide|include|specify|discuss)`,
    String.raw`\bnot\s+(?:established|specified|mentioned|covered|addressed|available)\s+(?:by|in)\s+the\s+(?:provided\s+|given\s+|retrieved\s+)?(?:evidence|documents?|pages?|orders?)`,
    String.raw`\bno\s+(?:specific\s+|relevant\s+)?information\s+(?:about|on|regarding|is\s+available)`,
    String.raw`\bthere\s+is\s+no\s+(?:specific\s+)?information\b`,
    "कोई\\s+(?:विशिष्ट\\s+|स्पष्ट\\s+|संबंधित\\s+)?जानकारी\\s+(?:नहीं|उपलब्ध\\s+नहीं)",
    "जानकारी\\s+(?:नहीं\\s+(?:दी|मिली|है)|उपलब्ध\\s+नहीं)",
    "(?:साक्ष्य|प्रमाण|दस्तावेज़ों|दस्तावेजों|पृष्ठों)\\s+में\\s+[^।]*?(?:उल्लेख|जानकारी|प्रावधान)\\s+नहीं",
    // Describing the sources instead of answering: "स्रोत S1 में केवल ई-रिक्शा …",
    // "Sources S2 and S5 concern road safety …" (metro fare, 3 Oct eval).
    String.raw`(?:^|\s)(?:स्रोत|sources?)\s+S\d`,
    "प्रस्तुत\\s+(?:प्रमाण|साक्ष्य|स्रोत)",
  ].join("|"),
  "iu",
);

/**
 * True when most of an answer only says the pages do not answer the question
 * (two or more sentences, a strict majority of them "not found"). One such
 * sentence beside real content is a normal answer: "the order sets no time
 * limit, but …".
 */
export function isProseNonAnswer(draft: string): boolean {
  if (draft.length > 1500) return false;
  const sentences = draft
    .replace(/\[S\d+[^\]]*\]/g, " ")
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((sentence) => sentence.replace(/[\s.।]/g, "").length > 3);
  if (sentences.length < 2) return false;
  const nonAnswers = sentences.filter((sentence) => NON_ANSWER_SENTENCE.test(sentence)).length;
  return nonAnswers * 2 > sentences.length;
}

/** A suggested follow-up the cited orders do not answer (they are the only ones searched). */
export function followUpNotCoveredMessage(language: "en" | "hi"): string {
  return language === "hi"
    ? "पिछले उत्तर में उद्धृत आदेशों में इस प्रश्न का उत्तर नहीं है। सभी आदेशों में खोजने के लिए प्रश्न को विषय सहित स्वयं लिखकर पूछें।"
    : "The orders cited in the previous answer do not answer this. To search all orders, type the question yourself with its subject.";
}

export function noEvidenceMessage(language: "en" | "hi", searchedAllDepartments: boolean): string {
  // No dead end: say what the archive holds and what to try next.
  if (language === "hi") {
    return [
      "संग्रहित शासनादेशों में इस प्रश्न का उत्तर देने वाला कोई आदेश नहीं मिला",
      searchedAllDepartments ? " (सभी विभागों में खोजा गया)।" : "।",
      " संग्रह में उत्तर प्रदेश शासन और भारत सरकार के आदेश व नियम हैं; अन्य राज्यों या निजी संस्थाओं के नियम इसमें नहीं हैं।",
      " प्रश्न में विभाग, योजना का नाम या शासनादेश संख्या जोड़कर दोबारा पूछें, अथवा “आदेश खोजें” से विषय के शब्दों द्वारा आदेश ढूँढें।",
    ].join("");
  }
  return [
    "I could not find a government order in the archive that answers this question",
    searchedAllDepartments ? " (all departments were searched)." : ".",
    " The archive holds Uttar Pradesh and Government of India orders and rules; other states' and private bodies' rules are not in it.",
    " Ask again with the department, scheme name or GO number, or use order search to find orders by subject words.",
  ].join("");
}
