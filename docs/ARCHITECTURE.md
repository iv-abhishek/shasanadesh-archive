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
