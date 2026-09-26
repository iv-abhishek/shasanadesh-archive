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
- `category`: grouping label (service-rules, policy, scheme-guideline, general-instruction,
  central-guideline, scope, not-found)
- `profileDepartments`: ask as an officer with these departments (a development profile is
  created once and cached in `data/eval/eval-users.json`; not available against production)
- `expectNoEvidence`: the archive has no such order, so the only passing answer is "no matching order"
- `expectScopeFallback`: the answer must come from outside the profile's departments (ADR-047)
- `expectedTextIncludesAny`: at least one of these words must appear in the answer

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
- "not found" answered correctly, and wrongly answered "not found" (ADR-047)
- shortened answers and answers that look cut off (ADR-048)
- answers with almost no text besides citations (ADR-049)
- searches widened beyond the profile's departments
- best-match relevance: lowest for answerable cases vs. highest for not-found cases, with
  a suggested `RAG_MIN_RELEVANCE` midway when they separate

The local benchmark runs sequentially because retrieval/reranking and MLX generation
share the Apple GPU.

## Commands

Fast retrieval-only baseline:

```bash
npm run eval:rag:search
```

Full search + answer evaluation (`eval:ask` is the same command):

```bash
npm run eval:ask
```

With the local MLX generator this takes about 30–45 minutes for the 24 cases (roughly
60–120 s per answer); run it after every change to retrieval, prompts or validation, and
compare the pass rate and failures with the previous report.

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

26 Sept 2026: 24 cases: the questions that failed or were checked by hand on 25–26 Sept
(solar pump, medical-officer seniority with a profile outside Medical and Health, Project
Alankar), 16 verified cases across the indexed orders (expected pages found by keyword in
native and OCR text), and 3 questions the archive cannot answer. Add every real failure
reported through thumbs-down (`npm run feedback:report`) as a case once its source page
is verified.

The first two cases were the original smoke cases. Expand toward
30-50 cases only from verified corpus evidence, covering Hindi/English, OCR-only pages,
native pages, numeric conflicts, exact-order lookup, policy concepts, dates, amounts,
percentages, rule/section identifiers, no-evidence cases, and citation-placement cases.

Once the set is large enough, freeze a baseline and require measurable improvement or
no regression for retrieval and safety changes.


## Filter evaluation

`eval/filter-cases.json` contains separately scored retrieval-filter cases. These cases
verify that constraints are applied before candidate generation rather than merely
filtering the returned top-K list.

Run:

```bash
npm run eval:filters
```

The initial filter cases are based only on results already manually verified against the
live retrieval API.

## Candidate inventory

Do not inflate the scored benchmark with guessed expected pages.

Instead, build a corpus inventory:

```bash
export DATABASE_URL='postgresql://shasanadesh:shasanadesh_dev@localhost:5432/shasanadesh'
npm run eval:inventory
```

This writes:

- `data/eval/corpus-inventory.json`
- `data/eval/corpus-inventory.md`

The inventory groups pages by evidence status and includes representative page text.
Use it to identify candidate questions, then inspect the original PDF page before adding
the case to `eval/rag-cases.json`.

A useful 30-50 case target should deliberately cover Hindi/English, native-primary,
OCR-only, native/OCR agreement, numeric conflicts, exact source lookup, department/date
filters, rule/section identifiers, amounts/percentages, unsupported questions, and
citation/source-page alignment.

## User feedback

Thumbs up / down votes (with an optional reason such as `wrong_citation` and a
comment) are stored per answer in `message_feedback`. Review them with:

```bash
npm run feedback:report            # recent votes
npm run feedback:report -- --down  # thumbs-down only
```

Treat thumbs-down answers as candidates: verify the correct source page
against the original PDF before adding a case to `eval/rag-cases.json`.

## Regenerate

Regenerate re-runs the latest question with a warmer temperature
(`LLM_REGENERATE_TEMPERATURE`, default 0.6) through the same citation and
numeric safety gate. The saved answer is replaced in place; earlier versions
are kept in the message's `metadata.previousVersions`, and any vote on the old
answer is cleared.

## Baseline command

Fast retrieval baseline plus filter regression checks:

```bash
npm run eval:baseline
```
