# Architecture

## Guiding Principle

The language model is the final reasoning/generation layer, not the database.

The authoritative knowledge lives in preserved government documents and structured
retrieval indexes.

## Implementation Status

The repository has a working local archive/search/chat MVP, but several items in this
document describe target architecture rather than shipped components:

- Initial ingestion works from a curated list of known Shasanadesh IDs. A small source
  registry now includes the Department of Expenditure GFR adapter; a broad multi-domain
  crawler is not implemented.
- The known-ID ingester stores captured PDFs and metadata locally and can archive the raw
  PDF plus a JSON manifest in B2 using its Native API. Uploads carry a SHA-1 checksum that
  B2 validates; returned size and checksum are checked before local metadata marks the
  capture archived. Existing local captures can be backfilled when B2 is enabled.
- Derived pages, OCR, and chunk artifacts are still local; B2 multipart uploads for files
  larger than 5 GB are not implemented.
- Page extraction, OCR variants, chunking, PostgreSQL/pgvector hybrid retrieval,
  reranking, chat orchestration, evidence validation, conversation persistence, and the
  Next.js MVP are present.
- Production identity/authorization, official-profile verification, and broad
  government-source coverage remain future work.

See [PRODUCT_VISION.md](PRODUCT_VISION.md) for audience, privacy, and closeable pilot
scope.

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

Original captures are immutable. With B2 configured, the known-ID ingester and source
ingester archive each original PDF and provenance manifest under
`archive/<collection>/raw/` and `archive/<collection>/processed/`. Collections currently
include `shasanadesh` and `doe-gfr`. The B2 Native API verifies SHA-1 during upload; the
pipeline also records SHA-256 and checks the upload response's byte count and SHA-1.
Without B2 credentials, ingestion remains local-only. If credentials are added later,
existing local captures can be uploaded before they are skipped.

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

Current migrations include corpus tables for documents, pages, page variants, chunks,
and ingestion runs. Workspace tables store departments, profiles, department assignments,
conversations, messages, conversation state, and development sessions.

pgvector stores chunk embeddings alongside the lexical search data. The first external
source adapter is registered, but a persistent source registry, relational capture
history, and document-relationship graph are still needed for broad multi-source
ingestion and reliable amendment/supersession reasoning.

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

The current Next.js MVP provides new chat, saved conversation history, streaming answers,
Hindi/English input, citations, source cards, and links to exact PDF pages. A richer
in-app evidence viewer, refined filters, profile-type onboarding, and production
authentication remain future increments.

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
