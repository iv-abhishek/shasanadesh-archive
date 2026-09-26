/**
 * Shared types between the API layer and retrieval service.
 *
 * `numeric_verification_status` is optional on the raw Python response because
 * the TypeScript orchestration layer currently derives it from retrieval
 * provenance. The API returned to the frontend always fills it in.
 */

export type NumericVerificationStatus =
  | "conflict"
  | "ocr_only_unverified"
  | "variants_agree"
  | "native_primary"
  | "unverified";

export interface RetrievalEvidence {
  label: string;
  source_id: string;
  document_title?: string | null;
  page_number: number;
  department: string | null;
  go_number: string | null;
  go_date: string | null;
  source_url: string;
  page_url: string;
  retrieval_role?: "direct" | "neighbor";
  anchor_page_number?: number | null;
  selected_variant: "native" | "ocr";
  selected_canonical: boolean;
  numeric_conflict: boolean;
  numeric_verification_status?: NumericVerificationStatus;
  rerank_score_raw: number;
  fused_score: number;
  matched_chunk_text: string;
  selected_page_text: string;
  canonical_page_text: string;
}

export interface RetrievalResponse {
  query: string;
  embedding_model: string;
  reranker_model: string;
  scores_are_raw_logits: boolean;
  evidence: RetrievalEvidence[];
  timings?: {
    embedding_ms?: number;
    hybrid_search_ms?: number;
    rerank_ms?: number;
    hydration_ms?: number;
    total_ms?: number;
  };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
