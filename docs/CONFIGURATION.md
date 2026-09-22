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

## Local PostgreSQL Development

The repository includes a Docker Compose development database using the pgvector
PostgreSQL image.

Local-only development connection example:

```text
postgresql://shasanadesh:shasanadesh_dev@localhost:5432/shasanadesh
```

This credential is only for the disposable local Docker development instance. Do not
reuse it in any hosted or production environment.

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
```

The reranker uses the same `.venv-embeddings` Python environment during the local
pilot.
