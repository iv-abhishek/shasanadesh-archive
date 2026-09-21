# Shasanadesh Archive

Open-source tooling for discovering, downloading, preserving, processing, and searching Uttar Pradesh Government Orders.

Initial target:

https://shasanadesh.up.gov.in/

## Project Goal

The goal of this project is to build a reliable archive and search system for Government Orders issued by the Government of Uttar Pradesh.

The first phase focuses only on acquiring and preserving the original documents correctly.

Later phases may add OCR, Hindi text normalization, semantic search, RAG, and an AI assistant with source citations.

## Phase 1

Current objectives:

- Discover Government Order document URLs
- Download original PDF files
- Preserve the original government source URL
- Verify downloaded files
- Calculate SHA-256 hashes
- Detect duplicate documents
- Store document metadata
- Build a reliable and resumable downloader

## Initial Source

Shasanadesh Uttar Pradesh:

https://shasanadesh.up.gov.in/

The website uses CAPTCHA for search, but direct Government Order PDF retrieval appears to be publicly accessible when the document identifier is already known.

One of the goals of the initial research is to understand how document identifiers and public document URLs are structured.

## Principles

### Preserve Originals

Original PDFs should be stored byte-for-byte without modification.

Derived files such as OCR text, normalized text, embeddings, and page images should always be stored separately from the original document.

### Maintain Provenance

Every document should retain information such as:

- Original source URL
- Department
- Government Order number
- Government Order date
- Subject
- Download timestamp
- SHA-256 hash

### Deduplicate Documents

The same Government Order may appear on multiple Uttar Pradesh government websites.

Documents should therefore be deduplicated primarily using their SHA-256 hash while preserving every known source URL.

## Planned Architecture

The long-term system may include:

- TypeScript / Node.js crawler
- PostgreSQL
- Backblaze B2 object storage
- OCR for scanned Hindi documents
- Legacy Hindi font normalization
- Page-level text extraction
- Hybrid keyword and semantic search
- Vector embeddings
- RAG-based AI assistant
- Source and page-level citations
- Government Order amendment and supersession tracking

## Development

Requirements:

- Node.js
- npm
- TypeScript

Install dependencies:

```bash
npm install
```

Run TypeScript files with:

```bash
npx tsx src/example.ts
```

## Repository Status

Early development and research.

The first milestone is to reliably download and verify a small set of real Government Order PDFs from Shasanadesh before expanding to large-scale crawling or AI processing.

## Disclaimer

This project is not an official Government of Uttar Pradesh or NIC project.

Official documents should always be verified against their original government sources where available.

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
