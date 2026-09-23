# RAG Service

Runtime topology:

```text
Browser / future Next.js UI
        |
        v
Node/TypeScript API :8787
        |
        +----> Python retrieval service :8788
        |        - Qwen3-Embedding-0.6B
        |        - PostgreSQL + pgvector
        |        - lexical/trigram retrieval
        |        - Qwen3-Reranker-0.6B
        |
        +----> OpenAI-compatible generator
```

Retrieval returns logical PDF pages, not opaque chunks. Evidence includes the exact
page number, official source URL, selected variant, canonical page text, numeric
conflict flag, and raw reranker logit.

Raw reranker logits are ordering signals, not factual confidence.

Citation contract:

```text
[S1 p.9]
```

`/api/chat` streams Server-Sent Events: `sources`, `token`, `done`, `error`.

## Answer safety gate

`/api/chat` does not directly forward raw model tokens.

The API buffers a draft, validates citations and numeric evidence safety, repairs once
if necessary, and only then emits the validated final answer over SSE. This prevents a
bad citation or OCR-corrupted critical number from being streamed before the server can
detect it.

### Numeric repair mode

When deterministic validation finds `unsafe_numeric_claim` or
`uncited_numeric_claim`, the repair prompt explicitly tells the generator to remove
risky exact numerics rather than merely adding a caveat to the same OCR-derived value.
The repair should preserve useful qualitative provisions with valid source-page
citations and must never invent a replacement number.

## Local context budget

The local Apple Silicon profile deliberately bounds generation context. Full page text
remains stored in the corpus; only the text inserted into the generator prompt is
clipped. This separates retrieval/storage fidelity from the laptop inference budget.
