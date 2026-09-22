/**
 * Derive a conservative numeric-verification state from retrieval provenance.
 *
 * Current corpus invariant:
 * - scanned/OCR-only pages have OCR as the canonical variant
 * - selective OCR added to native pages is non-canonical
 *
 * This is a safety classification, not factual confidence.
 */

import type {
  NumericVerificationStatus,
  RetrievalEvidence,
  RetrievalResponse,
} from "./types.js";

export function deriveNumericVerificationStatus(
  item: RetrievalEvidence,
): NumericVerificationStatus {
  if (item.numeric_conflict) {
    return "conflict";
  }

  if (
    item.selected_variant === "ocr" &&
    item.selected_canonical
  ) {
    return "ocr_only_unverified";
  }

  if (
    item.selected_variant === "ocr" &&
    !item.selected_canonical
  ) {
    return "variants_agree";
  }

  if (
    item.selected_variant === "native" &&
    item.selected_canonical
  ) {
    return "native_primary";
  }

  return "unverified";
}

export function enrichRetrievalResponse(
  response: RetrievalResponse,
): RetrievalResponse {
  return {
    ...response,
    evidence: response.evidence.map((item) => ({
      ...item,
      numeric_verification_status:
        item.numeric_verification_status ??
        deriveNumericVerificationStatus(item),
    })),
  };
}
