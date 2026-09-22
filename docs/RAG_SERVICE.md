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
