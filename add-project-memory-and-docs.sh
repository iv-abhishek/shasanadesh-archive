#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f package.json ]]; then
  echo "Run this from the shasanadesh project root."
  exit 1
fi

mkdir -p docs

cat > docs/PROJECT_MEMORY.md <<'EOF'
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
EOF

cat > docs/ARCHITECTURE.md <<'EOF'
# Architecture

## Guiding Principle

The language model is the final reasoning/generation layer, not the database.

The authoritative knowledge lives in preserved government documents and structured
retrieval indexes.

## System Components

### 1. Discovery

Sources:

- Shasanadesh public references
- department websites
- government archives
- sitemaps
- search engine indexed URLs
- human-assisted search where a CAPTCHA is required

Discovery produces source records and source URLs.

### 2. Capture

For every document capture, preserve:

- provider
- source ID
- encoded ID when applicable
- official source URL
- capture timestamp
- HTTP metadata
- exact raw bytes
- raw SHA256
- object-storage key

Original captures are immutable.

### 3. Text Extraction

Pipeline:

```text
PDF
├── native text usable -> retain native page text
└── native text missing/suspicious -> render page -> OCR hin+eng
```

Native and OCR text are retained separately.

### 4. Canonical Page Corpus

Every page record must include:

- document/source ID
- page number
- text
- text source: native or OCR
- page text hash

This is the citation boundary.

### 5. Chunking

Chunks remain page-bounded whenever possible so citations are unambiguous.

Every chunk includes:

- chunk ID
- source ID
- page number
- chunk index
- department
- GO number/date when known
- source URL
- text source
- chunk text
- content hash

### 6. Database

Planned PostgreSQL entities:

- `sources`
- `documents`
- `document_captures`
- `pages`
- `chunks`
- `document_relationships`
- `ingestion_runs`
- `crawl_sources`

pgvector will store semantic embeddings for chunks.

### 7. Retrieval

Use hybrid retrieval:

1. metadata filtering
2. lexical/full-text search
3. vector retrieval
4. result fusion
5. reranking
6. evidence selection

### 8. Answer Generation

The LLM receives:

- user question
- selected evidence chunks
- source metadata
- page numbers
- citation identifiers

The answer must not invent citations.

### 9. Frontend

Planned Next.js UI:

- new chat
- chat history
- streaming answer
- Hindi/English input
- citation chips
- source cards
- PDF viewer
- open exact cited page
- optional filters for department/year/order type

## Model Abstraction

Use a provider abstraction such as:

```ts
export interface LLMProvider {
  streamChat(input: ChatInput): AsyncIterable<ChatDelta>;
}
```

Do the same for:

- embedding provider
- reranker provider

Initial deployment may use Qwen through vLLM, but the product should be able to
switch to another model without changing the retrieval/data architecture.
EOF

cat > docs/CONFIGURATION.md <<'EOF'
# Configuration

Do not place real secrets in this document.

## Application

| Variable | Purpose |
|---|---|
| `NODE_ENV` | runtime environment |
| `APP_BASE_URL` | public application base URL |
| `LOG_LEVEL` | application log level |

## Database

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |

Planned extensions:

- `vector` (pgvector)

Never commit the real database URL.

## Backblaze B2 / S3-Compatible Storage

| Variable | Purpose |
|---|---|
| `B2_ENDPOINT` | S3-compatible endpoint |
| `B2_REGION` | bucket region |
| `B2_BUCKET` | bucket name |
| `B2_KEY_ID` | application key ID |
| `B2_APPLICATION_KEY` | application secret |

Recommended logical object layout:

```text
raw/shasanadesh/<year>/<department-id>/<source-id>/<capture-id>.pdf
processed/shasanadesh/<source-id>/pages/<page>.txt
processed/shasanadesh/<source-id>/metadata.json
```

Exact bucket/object naming can change, but preserve immutable raw captures.

## LLM

| Variable | Purpose |
|---|---|
| `LLM_BASE_URL` | OpenAI-compatible inference URL |
| `LLM_API_KEY` | optional/local or hosted auth |
| `LLM_MODEL` | selected generator model |

Initial candidate: Qwen3.6 family served by vLLM.

## Embeddings

| Variable | Purpose |
|---|---|
| `EMBEDDING_BASE_URL` | embedding service URL |
| `EMBEDDING_API_KEY` | auth if needed |
| `EMBEDDING_MODEL` | embedding model |

Initial candidate: Qwen3-Embedding family.

## Reranker

| Variable | Purpose |
|---|---|
| `RERANKER_BASE_URL` | reranker service URL |
| `RERANKER_API_KEY` | auth if needed |
| `RERANKER_MODEL` | reranking model |

Initial candidate: Qwen3-Reranker family.

## OCR

| Variable | Suggested Initial Value |
|---|---|
| `OCR_LANGS` | `hin+eng` |
| `OCR_DPI` | `300` |
| `TESSERACT_BIN` | `/opt/homebrew/bin/tesseract` |
| `PDFTOPPM_BIN` | `/opt/homebrew/bin/pdftoppm` |
| `PDFTOTEXT_BIN` | `/opt/homebrew/bin/pdftotext` |

## Shasanadesh

| Variable | Suggested Initial Value |
|---|---|
| `SHASANADESH_BASE_URL` | `https://shasanadesh.up.gov.in` |
| `CRAWL_DELAY_MS` | conservative delay, e.g. `3000` or higher |
| `CRAWL_CONCURRENCY_PER_DOMAIN` | conservative, e.g. `1` |

Respect public-site controls and do not automate CAPTCHA solving.
EOF

cat > docs/PRODUCT_PLAN.md <<'EOF'
# Product Plan

## Product

Working concept: a Uttar Pradesh Government Orders Assistant.

Primary experience:

> Ask a question in Hindi or English and receive an evidence-grounded answer with
> exact government-order and PDF-page citations.

## User Experience

Chat interface should support:

- Hindi and English questions
- streaming responses
- follow-up questions
- citations beside factual claims
- source sidebar/cards
- direct original-PDF access
- page-specific PDF navigation
- department/year filters
- reusable conversations
- clear distinction between government-source facts and assistant synthesis

## Quality Requirements

The assistant should:

- prefer official sources
- not silently fabricate missing metadata
- cite every material legal/administrative claim
- expose source date/department/order number when available
- distinguish current orders from older/superseded orders when relationships are known
- identify uncertainty when OCR or source metadata is weak

## Development Roadmap

### Phase 1 — Corpus Reliability

- selective OCR comparison for suspicious native pages
- metadata extraction
- normalization
- document relationship model
- ingestion manifests and quality metrics

### Phase 2 — Search

- PostgreSQL schema
- pgvector
- lexical/full-text index
- embedding ingestion
- hybrid retrieval
- reranker
- retrieval evaluation set

### Phase 3 — Assistant

- model-provider abstraction
- Qwen/vLLM integration
- citation-aware prompting
- answer streaming
- grounded-answer evaluation

### Phase 4 — Product UI

- Next.js ChatGPT-like interface
- chat persistence
- filters
- citation/source cards
- PDF viewer with cited page navigation

### Phase 5 — Broader Government Coverage

- department-site adapters
- sitemaps and archive crawlers
- recurring ingestion
- change detection
- amendment/supersession relationships

### Phase 6 — Production Quality

- authentication/roles if required
- audit logs
- observability
- backups
- B2 lifecycle strategy
- evaluation dashboards
- feedback loop
- optional model fine-tuning only after enough high-quality usage/relevance data exists
EOF

cat > docs/DECISIONS.md <<'EOF'
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
EOF

cat > docs/CODE_COMMENTING.md <<'EOF'
# Code Commenting Convention

Comments should explain **why**, invariants, source-system quirks, and safety
boundaries. Avoid comments that simply restate obvious syntax.

Recommended file header:

```ts
/**
 * Pipeline stage: <stage>
 *
 * Purpose:
 *   <what this file is responsible for>
 *
 * Important invariants:
 *   - preserve original source provenance
 *   - do not silently discard extraction variants
 *   - keep page numbers stable for citations
 *
 * See:
 *   docs/PROJECT_MEMORY.md
 *   docs/ARCHITECTURE.md
 */
```

Use inline comments for:

- Shasanadesh-specific behavior
- Unicode/Hindi normalization decisions
- hashing semantics
- OCR/native selection logic
- retry/rate-limit decisions
- citation/page invariants
- database transaction boundaries
- non-obvious model/retrieval parameters

When a parameter affects retrieval/OCR/model quality, prefer a named constant or
environment variable and document the reason for the default.
EOF

# Create .env.example only if it does not already exist.
if [[ ! -f .env.example ]]; then
cat > .env.example <<'EOF'
NODE_ENV=development
APP_BASE_URL=http://localhost:3000
LOG_LEVEL=info

DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/shasanadesh

B2_ENDPOINT=
B2_REGION=
B2_BUCKET=
B2_KEY_ID=
B2_APPLICATION_KEY=

LLM_BASE_URL=http://localhost:8000/v1
LLM_API_KEY=
LLM_MODEL=

EMBEDDING_BASE_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=

RERANKER_BASE_URL=
RERANKER_API_KEY=
RERANKER_MODEL=

OCR_LANGS=hin+eng
OCR_DPI=300
TESSERACT_BIN=/opt/homebrew/bin/tesseract
PDFTOPPM_BIN=/opt/homebrew/bin/pdftoppm
PDFTOTEXT_BIN=/opt/homebrew/bin/pdftotext

SHASANADESH_BASE_URL=https://shasanadesh.up.gov.in
CRAWL_DELAY_MS=3000
CRAWL_CONCURRENCY_PER_DOMAIN=1
EOF
else
  echo ".env.example already exists; leaving it unchanged."
fi

add_ts_header() {
  local file="$1"
  local stage="$2"
  local purpose="$3"

  [[ -f "$file" ]] || return 0

  if grep -q "Shasanadesh Archive — documented pipeline file" "$file"; then
    return 0
  fi

  local tmp
  tmp="$(mktemp)"

  cat > "$tmp" <<EOF
/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: ${stage}
 * Purpose: ${purpose}
 *
 * Invariants:
 * - preserve source provenance and stable source/page identifiers
 * - keep raw/native/OCR variants auditable instead of silently overwriting evidence
 * - keep parameters explicit and documented when they affect corpus/search quality
 *
 * Project hand-off docs:
 * - docs/PROJECT_MEMORY.md
 * - docs/ARCHITECTURE.md
 * - docs/CONFIGURATION.md
 * - docs/DECISIONS.md
 */

EOF
  cat "$file" >> "$tmp"
  mv "$tmp" "$file"
}

add_ts_header "src/lib/shasanadesh-id.ts" "source identity" "Encode/decode canonical Shasanadesh document IDs and URLs."
add_ts_header "src/ingest-known.ts" "ingestion" "Capture known PDFs and generate provenance/text metadata."
add_ts_header "src/verify-known-ids.ts" "verification" "Verify public-reference IDs against the direct document endpoint."
add_ts_header "src/probe-neighborhood.ts" "diagnostics" "Run small capped sequence-neighborhood diagnostics; not a bulk discovery crawler."
add_ts_header "src/ocr-needs.ts" "OCR" "OCR documents with insufficient native text while preserving native extraction."
add_ts_header "src/audit-ocr.ts" "quality audit" "Measure basic OCR-script/text output characteristics."
add_ts_header "src/audit-text-quality.ts" "quality audit" "Classify document-level native text quality."
add_ts_header "src/build-page-corpus.ts" "page corpus" "Build page-addressable canonical text while retaining native/OCR provenance."
add_ts_header "src/audit-page-corpus.ts" "quality audit" "Audit page-corpus coverage and text-source selection."
add_ts_header "src/build-chunks.ts" "chunking" "Build page-bound retrieval chunks with stable citation metadata."
add_ts_header "src/audit-chunks.ts" "quality audit" "Audit chunk size/distribution before indexing."
add_ts_header "src/search-chunks.ts" "local search" "Provide Unicode-safe lexical sanity-check search over chunk corpus."
add_ts_header "src/audit-native-pages.ts" "quality audit" "Flag suspicious native PDF text for selective OCR comparison."
add_ts_header "src/analyze-known-ids.ts" "dataset analysis" "Summarize known ID patterns and validate the seed dataset."
add_ts_header "src/promote-probe-results.ts" "dataset maintenance" "Promote verified diagnostic results into the known-ID dataset."

if [[ -f README.md ]] && ! grep -q "docs/PROJECT_MEMORY.md" README.md; then
cat >> README.md <<'EOF'

## Development Hand-off Documentation

Long-running project decisions and parameters are kept in the repository so the
project does not depend on one chat session:

- [`docs/PROJECT_MEMORY.md`](docs/PROJECT_MEMORY.md) — current state and durable context
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — environment/config parameter names
- [`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md) — product roadmap
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — architecture decisions
- [`docs/CODE_COMMENTING.md`](docs/CODE_COMMENTING.md) — commenting conventions

Never commit real credentials or secrets.
EOF
fi

echo
echo "Development memory/docs installed."
echo
echo "Run next:"
echo "  npx tsc --noEmit"
echo "  git status"
echo "  git diff --stat"
echo
echo "Review docs before committing."
