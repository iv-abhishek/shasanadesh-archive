# Product Plan

## Product

Working concept: a Uttar Pradesh Government Orders Assistant.

Primary experience:

> Ask a question in Hindi or English and receive an evidence-grounded answer with
> exact government-order and PDF-page citations.

## User Experience

Chat interface should support:

- Hindi and English questions
- streaming responses
- follow-up questions
- citations beside factual claims
- source sidebar/cards
- direct original-PDF access
- page-specific PDF navigation
- department/year filters
- reusable conversations
- clear distinction between government-source facts and assistant synthesis

## Quality Requirements

The assistant should:

- prefer official sources
- not silently fabricate missing metadata
- cite every material legal/administrative claim
- expose source date/department/order number when available
- distinguish current orders from older/superseded orders when relationships are known
- identify uncertainty when OCR or source metadata is weak

## Development Roadmap

### Phase 1 — Corpus Reliability

- selective OCR comparison for suspicious native pages
- metadata extraction
- normalization
- document relationship model
- ingestion manifests and quality metrics

### Phase 2 — Search

- PostgreSQL schema
- pgvector
- lexical/full-text index
- embedding ingestion
- hybrid retrieval
- reranker
- retrieval evaluation set

### Phase 3 — Assistant

- model-provider abstraction
- Qwen/vLLM integration
- citation-aware prompting
- answer streaming
- grounded-answer evaluation

### Phase 4 — Product UI

- Next.js ChatGPT-like interface
- chat persistence
- filters
- citation/source cards
- PDF viewer with cited page navigation

### Phase 5 — Broader Government Coverage

- department-site adapters
- sitemaps and archive crawlers
- recurring ingestion
- change detection
- amendment/supersession relationships

### Phase 6 — Production Quality

- authentication/roles if required
- audit logs
- observability
- backups
- B2 lifecycle strategy
- evaluation dashboards
- feedback loop
- optional model fine-tuning only after enough high-quality usage/relevance data exists
