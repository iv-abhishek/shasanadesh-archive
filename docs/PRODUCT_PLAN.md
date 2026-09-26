# Product Plan

This plan reflects the current code and the product direction in
[PRODUCT_VISION.md](PRODUCT_VISION.md). It replaces the original phase list, which
described search, RAG, and the UI as future work even though a local MVP now exists.

## Current baseline

Implemented in the repository:

- local ingestion of known Shasanadesh IDs and preservation of source metadata;
- native and OCR page variants, text-quality checks, chunks, and PostgreSQL loading;
- PostgreSQL lexical/vector hybrid retrieval, reranking, and page-level evidence;
- TypeScript chat/search API with citations, numeric safety checks, and SSE;
- Next.js chat MVP with source cards, saved conversations, and multi-department profiles;
- multi-department profile scope applied as an OR retrieval filter for default searches;
- optional B2 Native API archival of original PDFs and JSON manifests, including existing
  local-capture backfill and SHA-1 upload verification;
- a registered Department of Expenditure GFR adapter for bounded discovery across current
  and archive listings, with deduplicated local/B2 capture.

Not implemented:

- source adapters beyond the initial DOE GFR collection and the existing Shasanadesh
  known-ID pipeline;
- production user authentication and authorization;
- verified official profiles or a dedicated public-user onboarding path;
- a polished in-app document/evidence workspace;
- B2 storage for derived page, OCR, and chunk artifacts.

The B2 integration currently archives raw PDFs and metadata manifests only. Local
SHA-256 identifies the captured bytes; the Native API validates SHA-1 while accepting
the upload and the ingester checks the returned checksum and byte count.

## Milestone 1 — Close the archive-and-answer pilot

The first useful release should be bounded to a well-audited corpus and working evidence
flow. Do not make crawling every .gov.in domain a launch gate.

- Make capture runs resumable and report discovered, downloaded, duplicate, unavailable,
  upload-failed, and completed records clearly.
- Keep failed B2 uploads retryable; do not mark a capture archived until its PDF and
  manifest have both been accepted and verified.
- Keep native extraction, OCR, canonical page text, and embeddings as separate,
  traceable artifacts.
- Preserve the current bilingual search/chat experience, history, multi-department
  relevance scope, and exact source-page citations.
- Evaluate retrieval and answers against the existing Hindi/English evaluation corpus,
  including numeric and OCR-conflict cases.

## Milestone 2 — Add sources safely

- Audit the initial DOE GFR adapter against live listing changes and captured metadata.
- Add the next official source only after registering its owner, domain, jurisdiction,
  document families, crawl method, and request limits.
- Make ingestion idempotent and keep source URLs, capture history, hashes, and failure
  reasons.
- Normalize common metadata while retaining source-specific fields.
- Model amendments, replacements, corrigenda, and references explicitly. Do not infer
  legal precedence from publication date alone.

## Milestone 3 — Support real audiences

- Offer a general/public path with global search by default and optional department
  interests.
- Offer an official path with name, designation, state/district, and one or more verified
  active departments.
- Keep department scope as a relevance preference, separate from authorization.
- Put real official access behind authenticated identity and server-side permissions.
- Collect phone numbers only if a real feature requires them, with consent and private
  storage. Never use an unverified profile claim as access control.

## Milestone 4 — Finish the working interface

- Improve the MVP onboarding and department selector for keyboard, touch, and multiple
  active departments.
- Add a focused evidence view with exact-page document navigation and visible source,
  date, issuer, document type, and relationship details.
- Add useful department/date/type filters without obscuring the assistant's evidence.
- Make answer styles explicit: concise summary by default, simple explanation or example
  when requested.

## Pilot completion criteria

- Every ingested document has a source URL, capture record, byte count, and checksum.
- Originals and metadata manifests are retrievable from B2 and checksum-verified;
  failed uploads remain retryable and are not reported as archived.
- Each answer's cited source and page can be opened and checked.
- Known OCR uncertainty and conflicting document versions are visible in the evidence.
- Multi-department profiles retrieve across all selected departments, while explicit
  source/department requests take precedence.
- The deployment guide clearly distinguishes development sessions from production
  identity and access control.

Broader .gov.in coverage is a continuing source-by-source program after this pilot, not a
claim that the whole government web has been exhaustively crawled.
