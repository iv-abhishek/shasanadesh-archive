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

/** The model's agreed reply when none of the evidence answers the question. */
export const NO_ANSWER_TOKEN = "NO_ANSWER_IN_EVIDENCE";

export function isNoAnswer(draft: string): boolean {
  return draft.includes(NO_ANSWER_TOKEN) && draft.replace(NO_ANSWER_TOKEN, "").trim().length < 160;
}

export function noEvidenceMessage(language: "en" | "hi", searchedAllDepartments: boolean): string {
  if (language === "hi") {
    return [
      "संग्रहित शासनादेशों में इस प्रश्न का उत्तर देने वाला कोई आदेश नहीं मिला",
      searchedAllDepartments ? " (सभी विभागों में खोजा गया)।" : "।",
      " कृपया प्रश्न को दूसरे शब्दों में पूछें, या विभाग, योजना अथवा शासनादेश संख्या का उल्लेख करें।",
    ].join("");
  }
  return [
    "I could not find a government order in the archive that answers this question",
    searchedAllDepartments ? " (all departments were searched)." : ".",
    " Try rephrasing it, or mention the department, scheme or GO number.",
  ].join("");
}
