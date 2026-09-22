# Shasanadesh Archive — Project Memory

This file is the durable hand-off document for development. Keep it updated whenever
the architecture, data model, model choices, environment, or project state changes.

## Product Goal

Build a trustworthy ChatGPT-like assistant for Uttar Pradesh government orders.

The system should:

- archive original government PDFs
- preserve provenance and capture history
- extract/OCR Hindi and English text
- search across departments and years
- answer questions in Hindi and English
- cite the exact source document and PDF page
- allow a user to open the original PDF at the cited page
- remain model-agnostic so the LLM can be swapped later

## Repository

- GitHub: https://github.com/iv-abhishek/shasanadesh-archive
- Local development path: `/Users/apple/Downloads/projectai/shasanadesh`

## Current Corpus State

As of 2026-09-21:

- known Shasanadesh IDs: 25
- PDFs successfully ingested: 24
- unavailable historical reference: `1#173#10#2016`
- page-level corpus: 125 pages
- chunk corpus: 236 chunks
- documents using native text: 21
- documents using OCR: 3
- scanned/OCR documents:
  - `22#50002#10#2024`
  - `25#201#2#2020`
  - `5#163#2#2021`
- native page quality audit:
  - pages audited: 95
  - OK: 7
  - review: 43
  - suspicious: 45
  - affected documents: 21

The native-page audit is a heuristic and may over-flag valid Hindi. Do not
automatically replace all flagged text. Compare native extraction with OCR first.

## Shasanadesh ID Format

`id1` is URL-encoded Base64 of four numeric fields separated by `#`.

Example:

```text
NCMxNjMjMSMyMDIy
↓ Base64 decode
4#163#1#2022
```

Current inferred field meaning:

1. sequence / record number within a grouping
2. department or internal department ID
3. section / internal subgroup
4. year

The field semantics are inferred from evidence and are not an official schema.

Known department IDs observed:

- 6 — Civil Aviation
- 34 — Public Works
- 37 — Agriculture
- 38 — Food and Civil Supplies
- 162 — Finance
- 163 — Personnel
- 173 — Secondary Education (historical sample)
- 180 — Vocational Education and Skill Development
- 201 — Medical and Health
- 50002 — Secondary Education (later sample)

Department IDs can change over time. Never treat this mapping as globally permanent.

## Direct Document Endpoint

```text
https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=<encoded-id>
```

Known direct PDF retrieval works without the search CAPTCHA.

Do not automate CAPTCHA solving.

Do not turn diagnostic ID-neighborhood probing into unrestricted bulk enumeration.
Prefer publicly indexed references, government department sites, sitemaps, search
engines, and human-assisted discovery where required.

## Important PDF Integrity Finding

Shasanadesh can rewrite PDF metadata on retrieval, including modification date and
PDF trailer/ID information.

Therefore:

- `raw_sha256` identifies one exact captured byte stream
- `sourceId` identifies the logical Shasanadesh source record
- normalized/content hashes identify logical extracted content
- do not use raw SHA256 alone for document-level deduplication

Keep capture history.

## Text Processing Rules

Keep these separately:

- `original.pdf`
- native extraction (`text.txt`)
- OCR result (`ocr.txt`)
- page-level canonical text
- page-level provenance (`native` or `ocr`)
- content hashes

Never overwrite native extraction with OCR.

Hindi search normalization must preserve Unicode combining marks (`\p{M}`).
Removing combining marks corrupts words such as `वरिष्ठता` and `वेतन`.

## Local Development Environment

Observed environment:

- macOS Apple Silicon
- Node.js `v24.19.0`
- tsx `v4.23.15`
- TypeScript `7.0.2`
- Tesseract `5.5.2`
- OCR languages: `hin`, `eng`
- `pdftotext`: Homebrew Poppler
- `pdftoppm`: Homebrew Poppler

## Intended Product Stack

- Frontend: Next.js + React + TypeScript
- UI: ChatGPT-like streaming conversation interface
- API/orchestration: Node.js + TypeScript
- Database: PostgreSQL
- Vector search: pgvector
- keyword/full-text search: PostgreSQL initially
- object storage: Backblaze B2 / S3-compatible API
- OCR: Tesseract first, stronger fallback later
- model serving: vLLM, OpenAI-compatible API
- generator candidate: Qwen3.6 family
- embeddings candidate: Qwen3-Embedding family
- reranker candidate: Qwen3-Reranker family

The application must not depend directly on one model vendor. Use provider interfaces.

## Retrieval Architecture

```text
user question
    ↓
query normalization
    ↓
metadata filters
    ↓
keyword/full-text retrieval
    +
vector retrieval
    ↓
merge candidates
    ↓
reranker
    ↓
top source chunks/pages
    ↓
LLM answer
    ↓
exact document + page citations
```

Exact strings matter in government records, so vector-only search is not acceptable.

## Development Preferences

- Prefer TypeScript/Node.js for crawler, API, search, and application code.
- Use Python only where it clearly improves heavy OCR/data processing.
- Keep scripts reproducible.
- Keep `data/` out of Git.
- Keep `.env` out of Git.
- Keep `.env.example` in Git.
- Comment non-obvious code and data invariants.
- Update project docs whenever architecture or parameters change.
- Never put passwords, tokens, DB credentials, B2 application keys, or API keys in
  documentation, ChatGPT memory, or source control.

## Selective OCR Repair Stage

After the initial native-page quality audit, the repair strategy is:

1. identify suspicious native pages
2. OCR only those pages at 300 DPI with `hin+eng`
3. compare native and OCR text using quality metrics
4. retain both variants
5. do not replace canonical page text until the comparison is reviewed

Scripts:

- `npm run compare:suspicious`
- `npm run audit:selective-ocr`

Default pilot:

- quality threshold: `55`
- maximum pages per run: `12`

These are pilot parameters, not permanent production settings.

## OCR Retrieval-Variant Rule

Selective OCR pilot result:

- 45 suspicious native-page candidates at threshold <=55
- first 12 OCR comparisons all had much better Hindi readability scores
- manual inspection found OCR can corrupt dates/numbers/identifiers even when prose
  becomes substantially cleaner

Therefore OCR is not automatically canonical.

The retrieval corpus may contain parallel native/OCR variants for the same logical page.
Search/reranking must deduplicate on `sourceId + pageNumber`.
Critical numeric facts require source-page verification when variants disagree.

## PostgreSQL / pgvector Foundation

Planned relational identity:

- document: `source_id`
- logical page: `(source_id, page_number)`
- page variant: native/OCR representation of a logical page
- chunk: retrieval chunk tied to one page variant

Important page field:

- `numeric_conflict`: parallel native/OCR variants disagree on numeric tokens

Embedding storage is initially a dimensionless pgvector `vector` column. The embedding
dimension and ANN index will be added only after the embedding model is selected and
evaluated.

## Embedding Pilot

Initial semantic-retrieval pilot:

- model: `Qwen/Qwen3-Embedding-0.6B`
- dimensions: `1024`
- passage embeddings: no instruction
- query embeddings: task instruction enabled
- similarity: cosine
- initial ANN index: pgvector HNSW
- hybrid fusion: vector + PostgreSQL lexical/trigram using weighted RRF
- final retrieval deduplication boundary: logical page (`source_id + page_number`)

Do not treat this model or dimension as permanent until Hindi/English retrieval
evaluation is complete.

## Hybrid Retrieval Pilot Result

The first Qwen3 embedding + PostgreSQL hybrid searches successfully retrieved:

- Finance pay-fixation pages for `वेतन निर्धारण`
- Agriculture solar-pump pages for `सोलर पम्प`
- Medical & Health seniority rules for `medical officer seniority`

The English Medical Officer query was particularly strong: seniority pages ranked at
the top.

The hybrid stage still admits some unrelated lower-ranked pages and frequently chooses
OCR alternates on Hindi queries. Numeric-conflict warnings are correctly propagated.

Next precision stage:

- reranker: `Qwen/Qwen3-Reranker-0.6B`
- rerank top 24 fused chunks
- final deduplication by logical page
- do not use reranker score as factual-verification confidence

## RAG Service Milestone

- retrieval service: port 8788
- TypeScript RAG API: port 8787
- generator: `LLM_BASE_URL` + `LLM_MODEL`
- citation format: `[S1 p.<page>]`
- numeric-conflict pages provide selected and canonical variants to generation
