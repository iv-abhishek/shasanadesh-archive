# Shasanadesh Archive

Open-source tooling for discovering, downloading, preserving, processing, and searching Uttar Pradesh Government Orders.

Initial target:

https://shasanadesh.up.gov.in/

## Project Goal

Build a dependable archive and bilingual research assistant for Government Orders and
related official guidance. The long-term corpus includes Shasanadesh and other registered
official government sources. Answers should be concise, traceable to exact source pages,
and clear about uncertainty.

See [Product Vision](docs/PRODUCT_VISION.md) for users, profile workflow, source policy,
release scope, and success criteria.

## Current MVP foundation

The repository already includes:

- local ingestion for known Shasanadesh document IDs and a registered Department of
  Expenditure GFR listing adapter, with source metadata and hashes;
- page-level extraction, OCR variants, chunking, and PostgreSQL loading;
- PostgreSQL lexical plus pgvector retrieval with reranking;
- a TypeScript API with citations, numeric-evidence checks, and streamed responses;
- a working Next.js chat MVP with source cards, saved history, and multi-department
  development profiles;
- optional Backblaze B2 archival for original PDFs and JSON manifests, with remote
  SHA-1 verification and local SHA-256 provenance.

Still to build: adapters for more government sources, production identity and
authorization, and the polished official-versus-public profile journey. Processed
page/chunk artifacts are not uploaded to B2 yet.

## Initial Source

Shasanadesh Uttar Pradesh:

https://shasanadesh.up.gov.in/

The website uses CAPTCHA for search, but direct Government Order PDF retrieval appears to be publicly accessible when the document identifier is already known.

The first additional source adapter covers the Department of Expenditure's General
Financial Rules listings, including the current and archive pages. Run
`npm run ingest:doe-gfr` to discover and capture the bounded listing pages. The importer validates
official PDF responses, records provenance and native text metadata, and archives originals
plus manifests to the `doe-gfr` B2 collection when B2 is configured. See
[Configuration](docs/CONFIGURATION.md) for crawl limits and storage setup.

For a scanned capture, run `npm run ocr:needs -- --source-id <source-id>` and
`npm run build:pages -- --source-id <source-id>`. These steps preserve OCR text
separately, prefer it only when the native page has little text, and refresh the B2
metadata manifest without re-uploading the original PDF. Then rebuild retrieval
variants with `npm run build:retrieval-variants` and
`npm run build:retrieval-variant-chunks`, and load the corpus into PostgreSQL with
`npm run db:load`. `npm run build:chunks` remains available for the original chunk
corpus.


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

## Target Architecture

The long-term system is expected to include:

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

When `B2_KEY_ID`, `B2_APPLICATION_KEY`, and `B2_BUCKET` are configured,
`npm run ingest:known` stores immutable original captures and metadata manifests in B2.
The command loads the repo-root `.env` file when present. Without those values it keeps
its local-only behavior. See
[Configuration](docs/CONFIGURATION.md) for the B2 setup and [Product Plan](docs/PRODUCT_PLAN.md)
for the remaining pilot work.

## Development

Requirements:

- Node.js
- npm
- TypeScript

Install dependencies:

```bash
npm install
```

Start the whole local app (PostgreSQL must already be running):

```bash
npm run dev:all
```

This starts the MLX generator (:8791), retrieval service (:8788), RAG API
(:8787) and web app (:3000) with labelled logs, reuses any that are already
running, and stops them all on Ctrl+C. Use `npm run dev:all -- --no-generator`
when `LLM_BASE_URL`/`LLM_MODEL` in `.env` point at a hosted model. Then open
http://127.0.0.1:3000.

Run TypeScript files with:

```bash
npx tsx src/example.ts
```

## Repository Status

The project has a working local search/chat MVP. The next pilot milestones are
reviewing the first DOE GFR capture, improving corpus processing and evidence-quality
evaluation, and adding further source adapters. Broad government-site coverage is a
continuing expansion goal, not a prerequisite for the first useful release.

## Disclaimer

This project is not an official Government of Uttar Pradesh or NIC project.

Official documents should always be verified against their original government sources where available.

## Development Hand-off Documentation

Long-running project decisions and parameters are kept in the repository so the
project does not depend on one chat session:

- [`docs/PROJECT_MEMORY.md`](docs/PROJECT_MEMORY.md) — current state and durable context
- [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md) — product direction and pilot scope
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — environment/config parameter names
- [`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md) — product roadmap
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — architecture decisions
- [`docs/CODE_COMMENTING.md`](docs/CODE_COMMENTING.md) — commenting conventions

Never commit real credentials or secrets.
