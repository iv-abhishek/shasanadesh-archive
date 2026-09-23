# RAG Evaluation

The project uses a fixed, version-controlled evaluation set so retrieval and answer
changes are measured rather than judged from one or two manual queries.

## Case file

`eval/rag-cases.json`

Each case may define:

- `id`
- `query`
- `language`
- `expectedSourceIds`
- `expectedPagesBySource`
- `requireCitation`
- `allowFallback`
- `notes`

Only add expected source/page labels after they have been verified against the corpus.
Do not invent expected pages simply to increase the benchmark size.

## Metrics

The harness records:

- source Hit@K
- page Hit@K
- source MRR
- page MRR
- deterministic answer validation rate
- repair rate
- qualitative salvage rate
- generic fallback rate
- expected citation-page hit rate
- internal numeric-placeholder leak rate
- search latency
- chat latency

The local benchmark runs sequentially because retrieval/reranking and MLX generation
share the Apple GPU.

## Commands

Fast retrieval-only baseline:

```bash
npm run eval:rag:search
```

Full search + answer evaluation:

```bash
npm run eval:rag
```

One case:

```bash
npm run eval:rag -- --case medical-officer-seniority
```

Limit the run:

```bash
npm run eval:rag -- --limit 2
```

Override the API or top K:

```bash
npm run eval:rag -- --api http://127.0.0.1:8787 --top-k 4
```

Reports are written to:

`data/eval/runs/<timestamp>.json`

and:

`data/eval/runs/<timestamp>.md`

## Expansion plan

The first two cases are verified smoke cases already exercised manually. Expand toward
30-50 cases only from verified corpus evidence, covering Hindi/English, OCR-only pages,
native pages, numeric conflicts, exact-order lookup, policy concepts, dates, amounts,
percentages, rule/section identifiers, no-evidence cases, and citation-placement cases.

Once the set is large enough, freeze a baseline and require measurable improvement or
no regression for retrieval and safety changes.
