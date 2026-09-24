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


## Conversation-aware retrieval

Chat requests may contain recent user turns. For likely follow-up questions, the API
builds a deterministic contextual retrieval query from the current question plus up to
two recent user questions.

Previous assistant answers are intentionally excluded from retrieval context. They are
generated text, not authoritative evidence.

The generator receives prior user-question context only to resolve references such as
"that order", "those officers", "what about this case", or comparable Hindi follow-ups.
All government-order factual claims must still come from the current retrieved evidence.

This is the first conversational layer. Later phases can add model-based query planning,
verified source/session state, neighboring-section expansion, and cross-document
relationship reasoning.


## Active-source stickiness

For likely follow-ups, the frontend sends an active-source hint derived from the most
recent successful turn's retrieved source cards. The API uses that hint only to
constrain retrieval:

1. exact source ID when available;
2. department only when source ID is unavailable;
3. unfiltered contextual retrieval only if the constrained search returns zero evidence.

Generated assistant text is never used to choose the active source.

The current user question also determines the response language. Devanagari-dominant
questions request Hindi output; otherwise the default is English.


## Intent routing and workspace scope

Very short social turns such as `hi`, `hi :D`, `thanks`, `okay`, `नमस्ते`, and `धन्यवाद`
are handled before RAG. These turns do not retrieve documents and do not consume the local
generator.

Substantive chat uses deterministic scope precedence:

```text
explicit source / department
        ↓
active conversation source / department
        ↓
user working departments (OR)
        ↓
global corpus
```

An explicit all-departments request bypasses the user's normal working scope.

If active-source or active-department retrieval returns zero evidence, the fallback is
the user's working-department scope before global search.


## Adjacent-page context expansion

`/api/search` preserves the original ranking contract. Expansion is enabled by the chat
orchestrator only.

```text
hybrid retrieval
  -> rerank
  -> logical-page dedup
  -> retain direct pages
  -> add bounded p-1 / p+1 pages from the same source
  -> hydrate evidence
  -> OCR/numeric safety
  -> generation + citation validation
```

Defaults:

- `RAG_NEIGHBOR_RADIUS=1`
- `RAG_MAX_EVIDENCE_PAGES=7`

Neighbor evidence includes `RETRIEVAL_ROLE=neighbor` and `ANCHOR_PAGE`. The generator is
told that adjacency is not relevance and must cite the exact page that supports a claim.
Neighbor text is clipped more aggressively to keep local-model context bounded.

Structured rule/section expansion remains a later step after reliable heading and rule
boundary extraction.


## Stage latency telemetry

The retrieval service reports embedding, hybrid-search, reranker, evidence-hydration,
and total retrieval-service timings. The RAG API adds retrieval round-trip, generation,
repair, deterministic validation, and total request time.

The final SSE `done` event carries these timings and the API logs the same breakdown.
