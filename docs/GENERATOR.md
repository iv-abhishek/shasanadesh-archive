# Generator Service

## Architecture

The generator remains behind an OpenAI-compatible interface.

For local Apple Silicon development:

- server: MLX LM
- default model: `mlx-community/Qwen3-8B-4bit`
- endpoint: `http://127.0.0.1:8790/v1`

The local model is intentionally a development/smoke-test choice. Production is free
to use a larger Qwen model served by vLLM or another OpenAI-compatible service without
changing the RAG API contract.

## Why a separate environment?

The embedding/reranker service already has a working Python environment and dependency
set. Generator dependencies live in `.venv-generator` so upgrades to MLX do not risk
breaking retrieval.

## Runtime topology

- PostgreSQL: 5432
- Python retrieval: 8788
- TypeScript RAG API: 8787
- local MLX generator: 8790

## Numeric evidence policy

Generation must obey the evidence status already produced by the TypeScript RAG layer.

- `conflict`: do not state disputed critical numbers without source-page verification.
- `ocr_only_unverified`: OCR-only critical numbers require source-page verification.
- `variants_agree`: extraction variants agree, but this is not legal/source-page proof.
- `native_primary`: native PDF text is primary evidence.
- `unverified`: treat conservatively.

The reranker score is relevance only and must not be described as confidence.

## Local run

1. `npm run generator:setup`
2. `npm run generator:serve`
3. keep `npm run retrieval:serve` running
4. `npm run api:dev:local-generator`
5. `npm run chat:test -- "medical officer seniority"`

The first generator start downloads the model.

## Thinking mode

For the local Qwen RAG answer path, MLX chat-template thinking is disabled with:

`--chat-template-args '{"enable_thinking":false}'`

Reason: Qwen3 can otherwise spend the generation budget in a `reasoning` field while
the TypeScript SSE bridge intentionally emits only normal answer tokens from
`delta.content`. The application must not expose hidden reasoning as the user-facing
answer.
