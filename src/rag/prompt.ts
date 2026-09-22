/**
 * Evidence-grounded generation prompt.
 *
 * Citation contract:
 *   [S1 p.9]
 */

import type { RetrievalEvidence } from "./types.js";
import { deriveNumericVerificationStatus } from "./verification.js";

export const RAG_SYSTEM_PROMPT = `
You are an assistant for Uttar Pradesh government orders and administrative rules.

Use ONLY the supplied evidence for factual claims about government orders.
Do not invent missing provisions, dates, amounts, rule numbers, GO numbers, eligibility
conditions, procedures, exceptions, or supersession relationships.

CITATIONS
- Cite factual claims inline using the exact form [S1 p.9].
- S1/S2/etc. refer to the supplied evidence blocks.
- Prefer citing the most directly supporting page.
- Do not cite a source that does not support the claim.

OCR / NUMERIC VERIFICATION
- NUMERIC_CONFLICT=NO does NOT mean numbers are verified.
- NUMERIC_VERIFICATION_STATUS=conflict means extraction variants disagree on numeric
  tokens. Do NOT silently choose a disputed numeric value.
- NUMERIC_VERIFICATION_STATUS=ocr_only_unverified means OCR is the canonical/only
  usable text representation. Critical dates, amounts, percentages, rule numbers,
  GO numbers, and identifiers must be verified against the cited source page before
  being stated as authoritative fact.
- NUMERIC_VERIFICATION_STATUS=variants_agree means native/OCR numeric tokens did not
  trigger the conflict detector. This improves confidence but is not source-page proof.
- NUMERIC_VERIFICATION_STATUS=native_primary means native PDF text is the primary
  evidence representation. It is still not a substitute for source-page verification
  for unusually consequential or ambiguous numeric claims.
- You may use risky pages for non-disputed qualitative provisions.

ANSWER QUALITY
- Answer the user's question directly.
- If the evidence does not establish the answer, say what is not established.
- Distinguish a rule/provision from an example, appendix, form, or explanation.
- Do not treat reranker scores as confidence or legal authority.
`.trim();

function clip(text: string, maxChars = 7000): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[...page text clipped...]`;
}

export function buildEvidenceContext(
  evidence: RetrievalEvidence[],
): string {
  if (evidence.length === 0) {
    return "NO EVIDENCE WAS RETRIEVED.";
  }

  return evidence
    .map((item) => {
      const verificationStatus =
        item.numeric_verification_status ??
        deriveNumericVerificationStatus(item);

      const header = [
        `SOURCE ${item.label}`,
        `SOURCE_ID=${item.source_id}`,
        `PAGE=${item.page_number}`,
        `DEPARTMENT=${item.department ?? "unknown"}`,
        `GO_NUMBER=${item.go_number ?? "unknown"}`,
        `GO_DATE=${item.go_date ?? "unknown"}`,
        `SELECTED_VARIANT=${item.selected_variant}`,
        `SELECTED_CANONICAL=${item.selected_canonical ? "YES" : "NO"}`,
        `NUMERIC_CONFLICT=${item.numeric_conflict ? "YES" : "NO"}`,
        `NUMERIC_VERIFICATION_STATUS=${verificationStatus}`,
      ].join("\n");

      const selected = [
        "SELECTED PAGE TEXT:",
        clip(item.selected_page_text),
      ].join("\n");

      const canonicalDiffers =
        item.canonical_page_text !== item.selected_page_text;

      const canonical = canonicalDiffers
        ? [
            "CANONICAL PAGE TEXT:",
            clip(item.canonical_page_text),
          ].join("\n")
        : "";

      return [header, selected, canonical]
        .filter(Boolean)
        .join("\n\n");
    })
    .join(
      "\n\n============================================================\n\n",
    );
}
