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
