/**
 * Answer from general knowledge when the archive has no page that answers
 * (ADR-083). Officers get an answer, clearly marked as not taken from an
 * archived order, instead of "not found" — the way a colleague would answer
 * from experience and say "check the current order".
 *
 * The app shows the label; the answer carries no [S# p.#] citations and is
 * never presented as validated. Titles of the closest archived documents are
 * given to the model as hints and listed under the answer for checking.
 */
import type { RetrievalEvidence } from "./types.js";

export const GENERAL_KNOWLEDGE_ENABLED = process.env.RAG_GENERAL_KNOWLEDGE !== "0";

export interface ClosestDocument {
  title: string;
  reference: string | null;
}

/** Up to three distinct documents among the retrieved pages, best first. */
export function closestDocuments(evidence: RetrievalEvidence[], limit = 3): ClosestDocument[] {
  const seen = new Set<string>();
  const out: ClosestDocument[] = [];
  for (const item of evidence) {
    if (item.retrieval_role === "neighbor" || seen.has(item.source_id)) continue;
    seen.add(item.source_id);
    const title = (item.document_title ?? "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    const reference = [item.go_number, item.go_date].filter(Boolean).join(", ") || null;
    out.push({ title: title.length > 140 ? `${title.slice(0, 137)}…` : title, reference });
    if (out.length >= limit) break;
  }
  return out;
}

export function buildGeneralKnowledgeMessages(
  question: string,
  language: "en" | "hi",
  closest: ClosestDocument[],
): Array<{ role: "system" | "user"; content: string }> {
  const system = `You are Sandarbh, an assistant for Uttar Pradesh government officers.
The archive search found no government order or rule page that answers this question, so answer from your own knowledge of Government of India and Uttar Pradesh rules, manuals, acts, schemes and procedures.
- Answer directly and practically, like an experienced officer briefing a colleague: the answer first, then at most about 6 short bullets or 180 words.
- Name the document each point comes from (for example "GFR 2017", "Manual for Procurement of Non-Consultancy Services", "Financial Handbook Vol. II"), but do NOT give rule, section, paragraph or GO numbers, and do NOT give amounts, percentages, time limits or dates: from memory these are often wrong, and an officer may quote them. Describe the provision in words instead and say which document to open for the exact figure.
- Say only what you are confident is right; leave out anything you are unsure of.
- If the question is about another state or a private body, say whose rules apply and answer what you know.
- If you do not know, say so in one sentence and name the rule book or department where it is likely to be found.
- Do not mention evidence, sources, the archive or the search, do not add a disclaimer (the app shows one), and do not write citations such as [S1 p.2].
RESPONSE LANGUAGE: ${language === "hi" ? "Hindi (Devanagari); identifiers and official English terms may stay in English" : "English"}.`;
  const hints = closest.length
    ? `\n\nPossibly related documents in the archive (titles only; not known to contain the answer):\n${closest
        .map((doc) => `- ${doc.title}${doc.reference ? ` (${doc.reference})` : ""}`)
        .join("\n")}`
    : "";
  return [
    { role: "system", content: system },
    { role: "user", content: `${question.trim()}${hints}` },
  ];
}

/** Remove what the model should not have written; empty when nothing usable is left. */
export function cleanGeneralKnowledgeAnswer(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/NO_ANSWER_IN_EVIDENCE/g, "")
    .replace(/\s*\[S\d+(?:\s+p\.\s*\d+)?\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The closing list of documents to check, in the answer's language. */
export function closestDocumentsFooter(closest: ClosestDocument[], language: "en" | "hi"): string {
  if (!closest.length) return "";
  const heading = language === "hi" ? "संग्रह में निकटतम दस्तावेज़ (जाँच के लिए):" : "Closest documents in the archive (to check):";
  return `\n\n${heading}\n${closest.map((doc) => `- ${doc.title}${doc.reference ? ` — ${doc.reference}` : ""}`).join("\n")}`;
}
