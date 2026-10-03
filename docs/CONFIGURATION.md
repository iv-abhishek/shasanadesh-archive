# Configuration

Do not place real secrets in this document.

## Application

| Variable | Purpose |
|---|---|
| `NODE_ENV` | runtime environment |
| `APP_BASE_URL` | public application base URL |
| `LOG_LEVEL` | application log level |
| `ARCHIVE_CONSOLE_WRITE` | `1` allows tier corrections from the archive console when `NODE_ENV=production` (always allowed in development) |
| `APP_TIME_ZONE` | IANA zone used when reports print dates (default `Asia/Kolkata`); stored timestamps stay UTC |
| `RAG_MIN_RELEVANCE` | minimum reranker relevance (0–1, default `0.1`) for a retrieved page to be used as evidence; see ADR-047 and the "Best match" row in the answer's latency panel |
| `RAG_QUERY_EXPANSION` | `0` turns off rewording the question into official search terms before retrieval (ADR-082; hosted answer model only) |
| `RAG_QUERY_EXPANSION_TIMEOUT_MS` | time limit for that rewording (default `6000`); on timeout the question is searched as asked |
| `RAG_PLAYBOOKS` | `0` turns off topic playbooks (ADR-091); questions are then always searched |
| `PLAYBOOK_DIR` | folder of playbook files (default `datasets/playbooks`) |
| `RAG_LEXICAL_TIMEOUT_MS` | time limit for the keyword half of search (default `4000`); past it the meaning (vector) half answers alone (ADR-092) |
| `RAG_PROCUREMENT_RULEBOOKS` | `0` stops searching procurement questions inside the procurement rule books first (ADR-093) |
| `RAG_CHAT_INCLUDE_ROUTINE` | `0` leaves confident routine (tier C) orders out of chat again (ADR-081) |
| `CORS_ORIGINS` | optional comma-separated origins allowed to call the API directly; empty by default because browsers use the same-origin Next.js proxy |

## Display time zone (web app)

Set in `apps/web/.env.local` (see `apps/web/.env.local.example`):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_APP_TIME_ZONE` | IANA zone for question times and the Today/Yesterday history groups (default `Asia/Kolkata`) |
| `NEXT_PUBLIC_APP_LOCALE` | locale for date/time formatting (default `en-IN`) |

Timestamps are stored and exchanged as UTC instants; only their display uses
this zone, so hosting on a UTC server or opening the app from another country
does not move a question to the wrong day. `NEXT_PUBLIC_*` values are inlined at
build time: rebuild after changing them. Invalid values fall back to the
defaults.

## Database

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |

Planned extensions:

- `vector` (pgvector)

Never commit the real database URL.

Set `DATABASE_URL` in the repository-root `.env` file (next to `package.json`),
not in `apps/web/.env.local`. The root `.env` file is ignored by Git. The database
migration, check, load, audit, and API development commands load this file; values
already exported in the shell take precedence. Node.js 24.10 or newer is required
for the optional env-file loading used by these commands. The Python commands (`embed:chunks`,
`retrieval:serve`, `search:hybrid`, `search:reranked`, `eval:inventory`) load
the same `.env` through `scripts/with-env.mjs`, so no manual `export` is needed.

For a hosted PostgreSQL database, copy its connection URI from that provider's
project dashboard, usually under **Connect** or **Connection details**, and set it
as `DATABASE_URL` in the root `.env`. Choose the provider's direct connection for
this long-running API unless that provider specifically requires a pooled URI.
Do not paste the URL into source code, screenshots, or chat; it contains the
database password.

## Backblaze B2 Native API Storage

| Variable | Purpose |
|---|---|
| `B2_NATIVE_API_URL` | optional HTTPS API base; defaults to `https://api.backblazeb2.com` |
| `B2_BUCKET` or `B2_BUCKET_NAME` | bucket name (`B2_BUCKET` is preferred; the uploader accepts either) |
| `B2_KEY_ID` | application key ID |
| `B2_APPLICATION_KEY` | application secret |
| `B2_REQUIRED` | set to `1` to fail ingestion instead of silently using local-only mode when B2 credentials are absent |

Create a Backblaze application key restricted to the target bucket, with `writeFiles`
permission and no delete permission. Keep the key ID and secret on the ingestion server;
never expose them to the browser. Configure all three required B2 values together. If none
are set, ingestion stays local-only; a partial configuration is an error.

The `ingest:known` npm script loads the repository-root `.env` file when present. Copy
`.env.example` to `.env` and fill in the B2 settings; values already exported in the shell
take precedence. This script uses Node's `--env-file-if-exists` option (Node.js 24.10+).

The known-ID ingester and DOE GFR source ingester upload each raw PDF and a JSON metadata manifest to the Native API.
Backblaze validates the SHA-1 checksum supplied with each upload, and the ingester
compares the returned checksum and byte count before recording the object references.
SHA-256 remains the capture fingerprint. Existing local PDFs can be uploaded on the next
ingestion run without downloading them again.

Object layout:

```text
archive/<collection>/raw/<source-id>/<capture-id>.pdf
archive/<collection>/processed/<source-id>/<capture-id>.metadata.json

Example collections: `shasanadesh` and `doe-gfr`.
```

Object names use the local directory form of the source ID (`#` becomes `-`),
for example `archive/shasanadesh/raw/17-46-2-2017/<capture-id>.pdf`. Objects
uploaded before this change keep their original percent-encoded names
(`17%2346%232%232017`); manifest refreshes still write next to them.

Run `npm run b2:check` to verify the archive without changing anything: it
lists local captures that are not yet in B2 or have a pending manifest
refresh, confirms the key can authorise and upload to the configured bucket,
and, when the key has `readFiles` or `listFiles`, re-checks each stored
object's size and SHA-1. `npm run b2:check -- --offline` runs only the local
audit. B2_ENDPOINT and B2_REGION are S3-API settings and are not used.

This initial integration supports single uploads up to 5 GB. Derived page, OCR, and chunk
artifacts are not uploaded yet. For a bucket-restricted key, do not use a filename prefix
that excludes either the `raw/` or `processed/` path.

`npm run storage:restore` downloads originals back from B2, so the key also needs the
`readFiles` capability (a key made with "Read and Write" access has it).

## Local disk (ADR-056)

| Variable | Purpose |
|---|---|
| `MIN_FREE_DISK_GB` | `ingest:portal` and `ingest:source*` stop before free space drops below this (default `40`; `0` turns the check off) |

## LLM

| Variable | Purpose |
|---|---|
| `LLM_BASE_URL` | OpenAI-compatible inference URL |
| `LLM_API_KEY` | optional/local or hosted auth |
| `LLM_MODEL` | selected generator model |
| `LLM_MAX_TOKENS` | answer token budget for English questions (default `900`) |
| `LLM_MAX_TOKENS_HI` | answer token budget for Hindi questions (default `1800`; Devanagari needs several times more tokens per word) |
| `LLM_EXTRA_BODY` | optional JSON merged into each generation request, e.g. `{"chat_template_kwargs":{"enable_thinking":false}}` for hosted Qwen3 |
| `RAG_STREAM_DRAFT` | `1` (default) streams the first draft as a muted, unchecked preview; `0` shows only the checked answer |
| `LLM_REPAIR_MAX_TOKENS` | optional cap for the repair pass; unset = same budget as the first draft |

If an answer still reaches its budget, it is cut back to the last complete sentence or
bullet (`src/rag/truncation.ts`) and badged "Shortened" rather than ending mid-word.

### Hosted answer-writing (OpenRouter) with local fallback (ADR-075)

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `openrouter` writes answers on OpenRouter; unset = `LLM_BASE_URL`/`LLM_MODEL` |
| `OPENROUTER_API_KEY` | OpenRouter key (needs credits for paid models) |
| `OPENROUTER_MODEL` | default `qwen/qwen3.6-35b-a3b`; e.g. `qwen/qwen3.8-27b`, `qwen/qwen3-32b` |
| `LLM_FALLBACK_BASE_URL` / `LLM_FALLBACK_MODEL` / `LLM_FALLBACK_API_KEY` | optional fallback; with `LLM_PROVIDER=openrouter` the local MLX server from `LLM_BASE_URL`/`LLM_MODEL` is the fallback by default |

`npm run dev:all` + `LLM_PROVIDER=openrouter`: OpenRouter writes, the local Qwen takes over
when OpenRouter is unreachable, out of credit (402), rate-limited (429) or failing (5xx),
before any text was written. `npm run dev:all -- --no-generator`: OpenRouter only, the
local model is not started (frees ~5 GB on the Mac). Qwen's thinking is turned off with
`reasoning.enabled=false`. The answer's `done` event and the API log name the model used.

Local development uses Qwen3-8B (MLX) at `http://127.0.0.1:8791/v1`. To try a hosted model,
point `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` at any OpenAI-compatible provider; when
the host is not local, generation no longer waits for the local GPU queue
(`LOCAL_GPU_SERIALIZE` still orders the local retrieval models). Compare with `npm run eval:ask`.

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
| `PDFINFO_BIN` | `pdfinfo` (from `PATH`) |

All OCR and PDF tool settings are optional; without them the tools are taken
from `PATH`, OCR uses `hin+eng`, and pages are rendered at 300 DPI.

## Government source ingestion

| Variable | Suggested Initial Value |
|---|---|
| `CRAWL_DELAY_MS` | conservative delay, e.g. `3000` or higher |
| `CRAWLER_USER_AGENT` | descriptive crawler identity |
| `DOE_GFR_MAX_PAGES` | maximum listing pages per DOE current/archive listing; default `3`, maximum `20` |
| `SHASANADESH_BASE_URL` | `https://shasanadesh.up.gov.in` |
| `CRAWL_CONCURRENCY_PER_DOMAIN` | conservative, e.g. `1` |
| `SHASANADESH_USER_AGENT` | optional override of `CRAWLER_USER_AGENT` for Shasanadesh downloads only |

Both ingesters wait at least 3 seconds between downloads (`CRAWL_DELAY_MS`
raises that). Re-downloading with `--force` copies the previous
`original.pdf` and `metadata.json` to `captures/<capture-id>/` in the document
directory and records them under `previousCaptures`, so earlier captures are
never overwritten.

The first registered external source is the Department of Expenditure GFR collection.
Run `npm run ingest:doe-gfr` to discover and capture its current and archive listings.
The importer follows only official `doe.gov.in` links, validates downloaded PDF bytes,
and deduplicates identical download URLs. It writes to `data/documents/` and, when B2
is configured, the `doe-gfr` B2 collection. Use `--limit 1` for a one-document
upload check before a full run. Listing pagination is bounded by
`DOE_GFR_MAX_PAGES`; individual source downloads above 500 MB are rejected.

OCR and page-corpus commands accept `--source-id` to process one capture rather than the
whole archive. If B2 is unavailable during a metadata refresh, local processing is
retained and `storageManifestSyncPending` is set; rerun the same targeted command when
B2 is reachable to refresh the manifest without uploading the original PDF again.

Respect each public site's access controls and published crawl rules. Do not automate
CAPTCHA solving.

## Local PostgreSQL Development

The repository includes a Docker Compose development database using the pgvector
PostgreSQL image.

Local-only development connection example:

```text
postgresql://shasanadesh:shasanadesh_dev@localhost:5432/shasanadesh
```

This credential is only for the disposable local Docker development instance. Do not
reuse it in any hosted or production environment.

This is a template for the repository's local database, not a URL to an external
PostgreSQL service. The external URL comes from the dashboard for the database you
created.

## PostgreSQL Without Docker

Docker is optional for local development.

If a local PostgreSQL server is already running, use:

```bash
npm run db:setup:local
```

This script:

- connects to the existing local PostgreSQL server
- creates the development `shasanadesh` role if missing
- creates the `shasanadesh` database if missing
- checks that pgvector is available
- enables `vector` and `pg_trgm`

Then export the printed `DATABASE_URL`.

Use:

```bash
npm run db:check
```

before migrations whenever there is uncertainty about which PostgreSQL instance
`DATABASE_URL` is reaching.

## Embedding Pilot Configuration

```text
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
EMBEDDING_DIMENSIONS=1024
EMBEDDING_BATCH_SIZE=8
```

The local pilot uses a separate Python virtual environment at `.venv-embeddings/`.
Model weights are downloaded only when embedding/search is first run.

## Reranker Pilot Configuration

```text
RERANKER_MODEL=Qwen/Qwen3-Reranker-0.6B
RERANK_CANDIDATES=24
RERANK_BATCH_SIZE=4
RAG_RERANK_COUNT=24
```

`RERANK_BATCH_SIZE` (retrieval service) sets how many passages the
cross-encoder scores per GPU pass; a trial at 12 was not faster on Apple
Silicon. `RAG_RERANK_COUNT` (API) sets how many fused candidates are
reranked. Reranking time grows roughly with it: 12 roughly halves rerank time
but may miss a relevant page, so check `npm run eval:rag:search` before
lowering it.

The reranker uses the same `.venv-embeddings` Python environment during the local
pilot.
