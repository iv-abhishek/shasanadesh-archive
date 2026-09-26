/**
 * Pipeline stage: source discovery
 *
 * Purpose:
 *   The contract every registered source adapter fulfils. An adapter only
 *   *discovers* documents on one official site; ingest-source.ts downloads,
 *   hashes, extracts and archives them.
 *
 * Invariants:
 *   - sourceId is stable across runs and starts with the adapter's prefix
 *     (e.g. "upgov-go-61-hi"), so collections never collide on disk, in the
 *     database or in B2 (archive/<collection>/...)
 *   - whatever the listing says about a document is kept verbatim in
 *     sourceRecord, so no listing metadata is lost even if we do not map it yet
 */

export type SourceLanguage = "hi" | "en" | "mixed" | "unknown";

export interface SourceDocument {
  sourceId: string;
  title: string;
  sourceUrl: string;
  downloadUrl: string;
  listingUrls: string[];
  issuer: string;
  jurisdiction: "central" | "state";
  department: string | null;
  documentType: string;
  goDate: string | null;
  goNumber: string | null;
  language: SourceLanguage;
  /** Title in each language when the listing gives both. */
  titles?: { hi?: string | null; en?: string | null };
  /** Other editions of the same order (e.g. the Hindi and English PDFs). */
  relatedSourceIds?: string[];
  /** The listing's own record for this document, kept verbatim. */
  sourceRecord?: Record<string, unknown>;
}

export interface SourceAdapter {
  id: string;
  /** B2 collection and provider name; also the separation key in the DB. */
  collection: string;
  displayName: string;
  allowedHosts: readonly string[];
  discover(): Promise<SourceDocument[]>;
}
