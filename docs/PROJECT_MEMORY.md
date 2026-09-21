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
