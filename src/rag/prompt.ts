/**
 * Evidence-grounded generation prompt.
 *
 * Citation contract:
 *   [S1 p.9]
 *
 * Prompt rules are necessary but not sufficient. The API performs a deterministic
 * citation/numeric-safety validation pass before answer text is released.
 */

import type { RetrievalEvidence } from "./types.js";
import { deriveNumericVerificationStatus } from "./verification.js";
import {
  isRiskyNumericStatus,
  prepareEvidenceTextForGeneration,
  prepareNumericMetadataForGeneration,
} from "./generation-safety.js";

export const RAG_SYSTEM_PROMPT = `
You are an assistant for Uttar Pradesh government orders and administrative rules.

Use ONLY the supplied evidence for factual claims about government orders.
Do not invent missing provisions, dates, amounts, rule numbers, GO numbers, eligibility
conditions, procedures, exceptions, or supersession relationships.

CITATIONS
- Cite factual claims inline using the exact form [S1 p.9].
- S1/S2/etc. refer to the supplied evidence blocks.
- Put a citation in every substantive paragraph or bullet that relies on retrieved evidence.
- Every sentence or line containing a numeric claim must contain a supporting citation.
- Prefer citing the most directly supporting page.
- Do not cite a source that does not support the claim.
- Never invent a source label or page number.
- A citation is an evidence marker, never a replacement for a missing value. Put it after the supported clause or sentence; never write constructions such as 'Level [S2 p.19]' to stand in for an unknown level number.

OCR / NUMERIC VERIFICATION
- NUMERIC_CONFLICT=NO does NOT mean numbers are verified.
- NUMERIC_VERIFICATION_STATUS=conflict means extraction variants disagree on numeric
  tokens. Do NOT silently choose a disputed numeric value.
- NUMERIC_VERIFICATION_STATUS=ocr_only_unverified means OCR is the canonical/only
  usable text representation. Critical dates, amounts, percentages, rule numbers,
  levels, GO numbers, and identifiers are not authoritative until checked against the
  cited original source page.
- For conflict, ocr_only_unverified, or unverified evidence, prefer answering
  qualitatively and OMITTING exact critical numbers.
- If an exact risky number must be mentioned, clearly label it OCR-unverified/disputed
  in the SAME sentence and say it requires verification against the cited original page.
- NUMERIC_VERIFICATION_STATUS=variants_agree means native/OCR numeric tokens did not
  trigger the conflict detector. This improves extraction confidence but is not
  source-page proof.
- NUMERIC_VERIFICATION_STATUS=native_primary means native PDF text is the primary
  evidence representation. It is still not a substitute for source-page verification
  for unusually consequential or ambiguous numeric claims.
- Exact numeric values are removed from risky generator-facing evidence. Never reconstruct or guess a removed value.
- Never reproduce UNVERIFIED_NUMERIC or any bracketed mask token in the answer; rewrite the sentence qualitatively instead.
- You may use risky pages for non-disputed qualitative provisions.

CONVERSATION CONTEXT
- Conversation context is for resolving references, continuity, and user intent only.
- Conversation context is NOT evidence for government-order facts.
- Do not treat prior user assertions or prior assistant answers as legal/administrative proof.
- Factual claims about orders must still be supported by the CURRENT retrieved evidence.

LANGUAGE
- Follow the RESPONSE LANGUAGE instruction supplied with the current request.
- If RESPONSE LANGUAGE is Hindi, answer in natural Hindi except for identifiers or official terms that are clearer verbatim.
- If RESPONSE LANGUAGE is English, answer in English.

NEIGHBOR CONTEXT
- RETRIEVAL_ROLE=direct means the page was selected by semantic/lexical retrieval and reranking.
- RETRIEVAL_ROLE=neighbor means the page was added only because it is adjacent to a directly retrieved page.
- A neighbor may contain a continuation, proviso, definition, heading, exception, or unrelated material.
- Use a neighbor only when its own text supports the claim.
- Cite the exact supporting page, not merely the direct page that caused the neighbor to be loaded.

ANSWER QUALITY
- Answer the user's question directly.
- Match the user's language when practical.
- If the evidence does not establish the answer, say what is not established.
- Distinguish a rule/provision from an example, appendix, form, or explanation.
- Do not treat reranker scores as confidence or legal authority.


FIRST-DRAFT OUTPUT CONTRACT
- Return the final answer itself. Do not expose planning, validation notes, masking tokens, or internal placeholders.
- Exact numeric values may be absent from risky evidence because they were removed before generation.
- Never guess, reconstruct, or infer a masked numeric value from context.
- When evidence is numerically risky, state only qualitative propositions that remain true without the masked values.
- Every factual sentence or bullet must end with at least one exact evidence citation such as [S2 p.19].
- A factual answer with no valid [S# p.#] citation is invalid.
- Numeric characters from risky evidence may appear only as part of citation syntax, not as factual claims.
- Prefer 1-3 concise cited bullets over an uncited narrative.
- Before returning the answer, silently check: no unsupported numeric claim; every factual unit has a valid citation.
`.trim();

const DIRECT_PAGE_CHARS = 2800;
const NEIGHBOR_PAGE_CHARS = 1200;

function clip(
  text: string,
  maxChars = DIRECT_PAGE_CHARS,
): string {
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

      const generationNumericsMasked =
        isRiskyNumericStatus(
          verificationStatus,
        );

      const selectedGenerationText =
        prepareEvidenceTextForGeneration(
          item.selected_page_text,
          verificationStatus,
        );

      const canonicalGenerationText =
        prepareEvidenceTextForGeneration(
          item.canonical_page_text,
          verificationStatus,
        );

      const sourceIdForGeneration =
        generationNumericsMasked
          ? "withheld-risky-numeric-metadata"
          : item.source_id;

      const goNumberForGeneration =
        prepareNumericMetadataForGeneration(
          item.go_number,
          verificationStatus,
        );

      const goDateForGeneration =
        prepareNumericMetadataForGeneration(
          item.go_date,
          verificationStatus,
        );

      const header = [
        `SOURCE ${item.label}`,
        `SOURCE_ID=${sourceIdForGeneration}`,
        `PAGE=${item.page_number}`,
        `RETRIEVAL_ROLE=${item.retrieval_role ?? "direct"}`,
        `ANCHOR_PAGE=${item.anchor_page_number ?? "none"}`,
        `DEPARTMENT=${item.department ?? "unknown"}`,
        `GO_NUMBER=${goNumberForGeneration}`,
        `GO_DATE=${goDateForGeneration}`,
        `SELECTED_VARIANT=${item.selected_variant}`,
        `SELECTED_CANONICAL=${item.selected_canonical ? "YES" : "NO"}`,
        `NUMERIC_CONFLICT=${item.numeric_conflict ? "YES" : "NO"}`,
        `NUMERIC_VERIFICATION_STATUS=${verificationStatus}`,
        `GENERATION_NUMERICS_MASKED=${generationNumericsMasked ? "YES" : "NO"}`,
      ].join("\n");

      // Neighbour pages are context only, so they get a smaller budget. Long
      // prompts dominate local generation time (prefill), especially for
      // token-heavy Hindi OCR text.
      const selected = [
        "SELECTED PAGE TEXT:",
        clip(
          selectedGenerationText,
          item.retrieval_role === "neighbor"
            ? NEIGHBOR_PAGE_CHARS
            : DIRECT_PAGE_CHARS,
        ),
      ].join("\n");

      const canonicalDiffers =
        !generationNumericsMasked &&
        item.canonical_page_text !==
        item.selected_page_text;

      const canonical = canonicalDiffers
        ? [
            "CANONICAL PAGE TEXT:",
            clip(canonicalGenerationText, 1400),
          ].join("\n")
        : "";

      return [
        header,
        selected,
        canonical,
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .join(
      "\n\n============================================================\n\n",
    );
}
