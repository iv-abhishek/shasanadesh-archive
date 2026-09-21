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
