# Architecture Decision Log

Keep entries append-only where practical.

## ADR-001 — RAG First

Decision: use retrieval-augmented generation rather than training a new foundation
model.

Reason: government orders change over time and require exact citations and provenance.

## ADR-002 — Preserve Original Captures

Decision: original PDFs are immutable artifacts.

Reason: reproducibility, auditability, and detection of later source changes.

## ADR-003 — Raw SHA Is Capture Identity, Not Logical Document Identity

Decision: use raw SHA256 for exact-byte integrity only.

Reason: Shasanadesh has been observed rewriting PDF metadata on retrieval.

## ADR-004 — Page Is the Citation Boundary

Decision: preserve page-level canonical text and keep every chunk tied to a page.

Reason: users must be able to verify an answer against the exact PDF page.

## ADR-005 — Native and OCR Text Stay Separate

Decision: never overwrite native PDF extraction with OCR.

Reason: both are evidence about extraction quality and may be useful for future
comparison/reprocessing.

## ADR-006 — Hybrid Retrieval

Decision: use lexical + vector + metadata retrieval followed by reranking.

Reason: government documents contain exact identifiers and terminology that vector
search alone can miss.

## ADR-007 — Model-Agnostic Application

Decision: application code talks through provider interfaces and OpenAI-compatible
inference APIs where practical.

Reason: Qwen is an initial candidate, not a permanent architectural dependency.

## ADR-008 — No Automated CAPTCHA Solving

Decision: do not automate CAPTCHA solving.

Reason: use public references, indexed URLs, department archives, and human-assisted
discovery instead.

## ADR-009 — Secrets Stay Out of Memory and Git

Decision: store configuration parameter names and non-secret endpoints/models in docs,
but never credentials, tokens, passwords, or application keys.

Reason: security and portability.

## ADR-010 — Selective OCR Before Canonical Replacement

Decision: when native PDF text looks suspicious, OCR the affected page and compare
both variants before changing canonical page text.

Reason: PDF text-quality heuristics can over-flag legitimate Hindi. OCR can also
introduce errors. The canonical corpus must not silently replace one uncertain
representation with another.

Operational rule:

- keep native page text
- keep selective OCR text
- record comparative metrics
- automatically recommend only when quality difference is large
- otherwise require review

## ADR-011 — One Shared Text-Quality Scorer

Decision: native-page auditing and selective OCR comparison must import the same
quality-scoring function from `src/lib/text-quality.ts`.

Reason: duplicated heuristics drifted apart and caused the native audit to report
suspicious pages while the OCR-comparison stage selected zero candidates.

## ADR-012 — OCR Is a Retrieval Variant, Not Automatically Canonical

Decision: when selective OCR improves readability but may alter numbers or identifiers,
store OCR as a parallel retrieval variant rather than replacing native page text.

Reason: the 12-page pilot showed substantially cleaner Hindi OCR, but also concrete
numeric/date corruption such as years and page/section numbers changing.

Retrieval rule:

- index native and OCR variants
- let both compete for recall/relevance
- deduplicate results by `sourceId + pageNumber`
- preserve canonical/native provenance
- verify critical numeric facts against the source page or a stronger vision/manual
  fallback when variants disagree

## ADR-013 — Docker Is Optional for Local PostgreSQL

Decision: support both a Docker/pgvector development database and an existing local
PostgreSQL installation.

Reason: developer machines may already run PostgreSQL and may not have Docker
installed. Database bootstrap must diagnose the actual server rather than assume the
container exists.

## ADR-014 — Qwen3-Embedding-0.6B Pilot at 1024 Dimensions

Decision: begin semantic-retrieval evaluation with `Qwen/Qwen3-Embedding-0.6B`
using its full 1024-dimensional output.

Reason:

- multilingual Hindi/English retrieval is required
- model size is practical for local evaluation
- Qwen3-Embedding supports retrieval instructions on the query side
- full dimensions avoid introducing a Matryoshka-dimension tradeoff into the first
  retrieval baseline

Documents/passages are embedded without an instruction. Queries use an English
retrieval-task instruction.

This is a pilot model choice, not permanent vendor/model lock-in.

## ADR-015 — Rerank Hybrid Candidates Before Answer Generation

Decision: rerank the strongest hybrid-retrieval chunks with
`Qwen/Qwen3-Reranker-0.6B` before selecting final logical pages.

Initial pipeline:

1. vector candidates
2. lexical/trigram candidates
3. weighted reciprocal-rank fusion
4. rerank top 24 chunks
5. deduplicate final results by logical page
6. pass only the strongest evidence pages to answer generation

Reason: hybrid retrieval has high recall but can surface loosely related pages,
especially with noisy OCR/native text. The reranker should improve precision without
discarding lexical/vector recall.

Reranker score measures relevance only. It does not resolve OCR-vs-native factual
conflicts.

## ADR-016 - Persistent Retrieval Service + TypeScript RAG Orchestration

Keep embedding/reranker inference in a persistent Python HTTP service. Keep application
orchestration, generator calls, and streaming in Node/TypeScript. Use an
OpenAI-compatible generator interface. Logical PDF pages remain the citation boundary.

## ADR-017 - Reranker Scores Are Not Confidence Scores

Qwen3-Reranker SentenceTransformers output is a raw logit used for ordering. It must
not be interpreted as factual confidence, legal authority, or extraction correctness.

## ADR-019 — Numeric Conflict Is Not Numeric Verification

`numeric_conflict = false` must never be interpreted as “numbers verified.”

For the current corpus, the TypeScript RAG boundary derives a conservative evidence
status from retrieval provenance:

- `conflict`
- `ocr_only_unverified`
- `variants_agree`
- `native_primary`
- `unverified`

Critical dates, amounts, percentages, rule numbers, GO numbers, and identifiers from
`conflict` or `ocr_only_unverified` evidence require source-page or stronger
vision/manual verification before being stated as authoritative fact.
