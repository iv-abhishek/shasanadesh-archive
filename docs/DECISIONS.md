# Architecture Decision Log

Keep entries append-only where practical.

## ADR-001 — RAG First

Decision: use retrieval-augmented generation rather than training a new foundation
model.

Reason: government orders change over time and require exact citations and provenance.

## ADR-002 — Preserve Original Captures

Decision: original PDFs are immutable artifacts.

Reason: reproducibility, auditability, and detection of later source changes.

## ADR-003 — Raw SHA Is Capture Identity, Not Logical Document Identity

Decision: use raw SHA256 for exact-byte integrity only.

Reason: Shasanadesh has been observed rewriting PDF metadata on retrieval.

## ADR-004 — Page Is the Citation Boundary

Decision: preserve page-level canonical text and keep every chunk tied to a page.

Reason: users must be able to verify an answer against the exact PDF page.

## ADR-005 — Native and OCR Text Stay Separate

Decision: never overwrite native PDF extraction with OCR.

Reason: both are evidence about extraction quality and may be useful for future
comparison/reprocessing.

## ADR-006 — Hybrid Retrieval

Decision: use lexical + vector + metadata retrieval followed by reranking.

Reason: government documents contain exact identifiers and terminology that vector
search alone can miss.

## ADR-007 — Model-Agnostic Application

Decision: application code talks through provider interfaces and OpenAI-compatible
inference APIs where practical.

Reason: Qwen is an initial candidate, not a permanent architectural dependency.

## ADR-008 — No Automated CAPTCHA Solving

Decision: do not automate CAPTCHA solving.

Reason: use public references, indexed URLs, department archives, and human-assisted
discovery instead.

## ADR-009 — Secrets Stay Out of Memory and Git

Decision: store configuration parameter names and non-secret endpoints/models in docs,
but never credentials, tokens, passwords, or application keys.

Reason: security and portability.

## ADR-010 — Selective OCR Before Canonical Replacement

Decision: when native PDF text looks suspicious, OCR the affected page and compare
both variants before changing canonical page text.

Reason: PDF text-quality heuristics can over-flag legitimate Hindi. OCR can also
introduce errors. The canonical corpus must not silently replace one uncertain
representation with another.

Operational rule:

- keep native page text
- keep selective OCR text
- record comparative metrics
- automatically recommend only when quality difference is large
- otherwise require review

## ADR-011 — One Shared Text-Quality Scorer

Decision: native-page auditing and selective OCR comparison must import the same
quality-scoring function from `src/lib/text-quality.ts`.

Reason: duplicated heuristics drifted apart and caused the native audit to report
suspicious pages while the OCR-comparison stage selected zero candidates.

## ADR-012 — OCR Is a Retrieval Variant, Not Automatically Canonical

Decision: when selective OCR improves readability but may alter numbers or identifiers,
store OCR as a parallel retrieval variant rather than replacing native page text.

Reason: the 12-page pilot showed substantially cleaner Hindi OCR, but also concrete
numeric/date corruption such as years and page/section numbers changing.

Retrieval rule:

- index native and OCR variants
- let both compete for recall/relevance
- deduplicate results by `sourceId + pageNumber`
- preserve canonical/native provenance
- verify critical numeric facts against the source page or a stronger vision/manual
  fallback when variants disagree

## ADR-013 — Docker Is Optional for Local PostgreSQL

Decision: support both a Docker/pgvector development database and an existing local
PostgreSQL installation.

Reason: developer machines may already run PostgreSQL and may not have Docker
installed. Database bootstrap must diagnose the actual server rather than assume the
container exists.

## ADR-014 — Qwen3-Embedding-0.6B Pilot at 1024 Dimensions

Decision: begin semantic-retrieval evaluation with `Qwen/Qwen3-Embedding-0.6B`
using its full 1024-dimensional output.

Reason:

- multilingual Hindi/English retrieval is required
- model size is practical for local evaluation
- Qwen3-Embedding supports retrieval instructions on the query side
- full dimensions avoid introducing a Matryoshka-dimension tradeoff into the first
  retrieval baseline

Documents/passages are embedded without an instruction. Queries use an English
retrieval-task instruction.

This is a pilot model choice, not permanent vendor/model lock-in.

## ADR-015 — Rerank Hybrid Candidates Before Answer Generation

Decision: rerank the strongest hybrid-retrieval chunks with
`Qwen/Qwen3-Reranker-0.6B` before selecting final logical pages.

Initial pipeline:

1. vector candidates
2. lexical/trigram candidates
3. weighted reciprocal-rank fusion
4. rerank top 24 chunks
5. deduplicate final results by logical page
6. pass only the strongest evidence pages to answer generation

Reason: hybrid retrieval has high recall but can surface loosely related pages,
especially with noisy OCR/native text. The reranker should improve precision without
discarding lexical/vector recall.

Reranker score measures relevance only. It does not resolve OCR-vs-native factual
conflicts.

## ADR-016 - Persistent Retrieval Service + TypeScript RAG Orchestration

Keep embedding/reranker inference in a persistent Python HTTP service. Keep application
orchestration, generator calls, and streaming in Node/TypeScript. Use an
OpenAI-compatible generator interface. Logical PDF pages remain the citation boundary.

## ADR-017 - Reranker Scores Are Not Confidence Scores

Qwen3-Reranker SentenceTransformers output is a raw logit used for ordering. It must
not be interpreted as factual confidence, legal authority, or extraction correctness.

## ADR-019 — Numeric Conflict Is Not Numeric Verification

`numeric_conflict = false` must never be interpreted as “numbers verified.”

For the current corpus, the TypeScript RAG boundary derives a conservative evidence
status from retrieval provenance:

- `conflict`
- `ocr_only_unverified`
- `variants_agree`
- `native_primary`
- `unverified`

Critical dates, amounts, percentages, rule numbers, GO numbers, and identifiers from
`conflict` or `ocr_only_unverified` evidence require source-page or stronger
vision/manual verification before being stated as authoritative fact.

## ADR-020 — OpenAI-Compatible Generator Boundary

The answer generator is accessed only through an OpenAI-compatible HTTP API.

Local Apple Silicon development uses MLX LM with a small quantized Qwen model so the
full RAG/chat path can be exercised on a laptop. Production model serving remains
replaceable and may use vLLM or another OpenAI-compatible service.

Embedding/reranker and generator Python environments remain separate to reduce
dependency coupling.

## ADR-021 — Disable Qwen Thinking for RAG Answer Streaming

The local Qwen3 generator runs with chat-template `enable_thinking=false`.

Without this setting, MLX may return generation in a `reasoning` field and exhaust the
token budget before producing `message.content`. The RAG API streams only user-facing
answer content and must not expose internal reasoning.

## ADR-022 — Deterministic Answer Safety Gate

Prompt instructions are not sufficient for citation or OCR-numeric safety.

Before any generated answer text is released to the client, the TypeScript API now:

1. buffers the complete model draft;
2. validates citation syntax and source/page membership;
3. requires numeric claims to carry a same-sentence/source-line citation;
4. blocks uncaveated numeric claims supported only by `conflict`,
   `ocr_only_unverified`, or `unverified` evidence;
5. attempts one evidence-grounded repair;
6. falls back to a conservative source-page review message if repair still fails.

The final validated answer is then emitted over the existing SSE `token` contract in
small text chunks. This deliberately trades first-token latency for a stronger
"no unsafe token leaves the server" invariant.

## ADR-024 — Bound Local RAG Context and MLX Prompt Cache

The Apple Silicon development stack hit a Metal out-of-memory failure when a RAG prompt
grew to roughly 27k tokens while MLX retained multiple prompt-cache sequences.

For local development:

- selected page text is clipped to 2,800 characters per evidence page;
- an alternate canonical page copy is clipped to 1,400 characters;
- chat retrieval defaults to four evidence pages;
- MLX prompt cache is limited to one sequence;
- the local generator defaults to port 8791.

This is a laptop memory budget, not a production retrieval-quality target. Production
should choose evidence budgets from measured retrieval/citation quality and available
serving memory.

## ADR-025 - Generation-safe numeric masking

For `conflict`, `ocr_only_unverified`, and `unverified` evidence, exact numeric tokens
remain in the corpus but are masked before answer generation. This keeps retrieval
lossless while reducing accidental copying of OCR-corrupted critical values.

## ADR-026 - Serialize shared local Apple GPU work

Local MPS retrieval/reranking and MLX generation share the Apple GPU. With
`LOCAL_GPU_SERIALIZE=1`, the API serializes those GPU operations. Production can set it
to `0` when retrieval and generation use isolated workers/GPUs.

## ADR-027 - Strict qualitative repair for unsafe numerics

Internal numeric masks are not user-facing content. The deterministic answer validator
now rejects leaked `UNVERIFIED_NUMERIC` placeholders.

When validation reports an unsafe numeric claim, uncited numeric claim, or leaked mask,
the single repair pass enters strict qualitative mode: exact numerics are omitted rather
than copied, guessed, or reconstructed. Numeric characters are permitted only inside the
required citation syntax. This is intended to preserve a useful qualitative answer while
keeping the source-page verification boundary intact.

## ADR-028 - Deterministic qualitative salvage before generic fallback

If the single model repair still fails numeric safety, the API performs one deterministic
salvage step before using the generic fallback. It does not rewrite facts. It retains only
claim units that already have a valid supplied source/page citation, contain no internal
mask placeholder, and contain no numeric token outside citation syntax.

This preserves useful cited qualitative material while continuing to fail closed for
unsafe numbers.

For the local laptop profile, the first answer is capped at 600 tokens and the repair at
450 tokens. Risky evidence also omits the alternate canonical page from generation to
reduce duplicated context and Apple unified-memory pressure.

## ADR-029 - Versioned RAG evaluation before frontend tuning

RAG quality changes are evaluated against a fixed, version-controlled case set rather
than individual manual prompts.

The evaluator measures retrieval source/page hits, reciprocal rank, validated-answer
rate, repair/salvage/fallback behavior, citation-page alignment, placeholder leakage,
and latency. Local runs are sequential to preserve the shared Apple GPU stability
invariant.

Expected source/page labels must be verified from the corpus before they are added to
the benchmark.

## ADR-030 - Thin frontend after backend evaluation baseline

The first frontend is a thin Next.js client over the existing API contract. It does not
reimplement retrieval, verification, or answer-safety logic in the browser.

The browser consumes only the stable SSE contract (`sources`, `token`, `done`, `error`),
renders exact page citations and verification status, and links users back to original
source pages. Backend safety remains authoritative.


## ADR-033 - Separate scored evaluation cases from candidate discovery

Only manually verified source/page expectations belong in the scored RAG benchmark.

Corpus inventory output and candidate queries are discovery aids, not benchmark truth.
This prevents benchmark growth from silently encoding guessed pages or model-generated
labels.

Retrieval-filter behavior is evaluated separately so a correct topical hit cannot hide a
filter violation.


## ADR-034 - Deterministic conversation-aware retrieval before model-based query planning

Multi-turn chat sends recent user questions to the API. The API enriches retrieval only
when the current question contains likely follow-up language.

Phase 1 deliberately excludes previous assistant answers from retrieval context because
generated text is not authoritative corpus evidence. The contextual retrieval query is
constructed deterministically, preserving exact identifiers and avoiding an additional
LLM call on the local shared GPU.

A model-based query planner may replace the heuristic later, but only after multi-turn
evaluation cases exist and identifier-preservation/factual-grounding regressions can be
measured.


## ADR-035 - Active-source stickiness and response-language preservation

Likely follow-up questions inherit a retrieval hint from the most recent successful
turn's dominant retrieved source. The hint constrains retrieval by exact source ID when
available, or department as a weaker fallback.

The hint comes from prior retrieval results, never from generated answer text. It is a
retrieval constraint, not evidence. If the constrained retrieval returns no evidence,
the system may retry the contextual query without the sticky filter.

Response language is detected deterministically from the current user question. Hindi
follow-ups should remain Hindi even when the retrieved corpus contains substantial
English text.


## ADR-036 - Persistent workspace profile and chat history before production authentication

User working departments, preferred language, conversations, messages, and conversation
state are persisted in PostgreSQL.

Working department scope is a retrieval preference, not authorization. Production
identity and document-access authorization remain a separate future layer.

Department assignments are temporal (`valid_from` / `valid_to`) so officer transfers can
be represented without destroying historical context.

Conversation messages may store retrieved source metadata, but generated assistant text
does not become corpus evidence.


## ADR-037 - Local onboarding and persistent history through same-origin workspace APIs

The development frontend stores only the workspace user UUID in browser local storage.
Profile data and conversation history live in PostgreSQL.

The browser talks to the workspace API through a same-origin Next.js proxy. This keeps
the frontend deployment boundary consistent with the existing RAG chat/search proxies.

Completed assistant turns persist the validated final answer, source-card metadata, and
conversation state. Raw unsafe generator drafts are never persisted.

This remains development identity, not authentication. Production identity and
authorization will replace the local UUID mechanism.


## ADR-038 - Route social turns before RAG and apply workspace department scope

Short greetings, thanks, acknowledgements, and farewells are classified deterministically
before retrieval. They receive a deterministic conversational response and do not invoke
embedding, reranking, or generation. These turns are still persisted in chat history but
do not change the active source, department, or topic state.

Substantive chat retrieval follows this precedence:

1. explicit source ID in the current question;
2. explicit known department in the current question;
3. active source for a likely follow-up;
4. active department for a likely follow-up;
5. the user's configured working departments;
6. global corpus when the profile is global or the user explicitly requests all departments.

Workspace department scope is an OR filter. It is a relevance boundary, not authorization.


## ADR-039 - HttpOnly cookie-backed development sessions

Development identity continuity uses an opaque random token stored in an HttpOnly,
SameSite=Lax cookie. PostgreSQL stores only the SHA-256 hash of the token.

Profile, department assignments, conversation history, and conversation state remain
server-side. Browser localStorage is no longer the active identity mechanism; an old
localStorage workspace UUID is accepted only once to migrate an existing development
profile into a cookie session.

The cookie is Secure in production mode and non-Secure on localhost development. The
development profile selector is disabled in production mode.

This is still not production authentication or authorization. A real identity provider
can later replace `dev-login` while keeping the same session/profile boundary.


## ADR-040 - Bounded adjacent-page expansion after retrieval

Chat retrieval expands final reranked logical pages with a bounded set of adjacent pages
from the same source document.

Invariants:

- semantic/vector/lexical retrieval and reranking choose direct pages first;
- adjacent pages never displace a direct page;
- expansion occurs only after logical-page deduplication;
- `/api/search` remains unexpanded so ranking/evaluation semantics stay stable;
- chat defaults to radius 1 with an overall evidence-page budget;
- neighbor pages are marked `retrieval_role=neighbor`;
- adjacency is context, not an assertion of relevance;
- citations must point to the exact page supporting the claim;
- neighbor pages retain the same OCR/numeric safety rules as direct pages.

This is page-boundary expansion, not yet a parsed rule/section graph.


## ADR-041 - Retrieval provenance, polished salvage, and stage latency

Adjacent pages are explicitly distinguished from directly retrieved/reranked pages in the
API and UI. Source cards show `Direct hit` or `Neighbor of p.N`; this is retrieval
provenance, not a confidence score.

Deterministic qualitative salvage strips leftover list punctuation, rejects obvious
dependent continuation fragments such as "This is followed by ...", preserves only
already safety-qualified cited claim units, and formats multiple surviving units as
readable bullets.

Latency diagnostics cover retrieval round-trip, embedding, hybrid search, reranking,
evidence hydration, generation, repair, deterministic validation, and total chat time.
These measurements are diagnostic, not SLAs.


## ADR-042 - Numbers must be found on a reliable cited page

Citing one native-text page next to a risky page no longer makes a numeric
sentence safe. The validator now requires every number in the sentence to
appear (after Devanagari-digit and thousands-separator normalisation) on a
cited page whose numerics are not `conflict`, `ocr_only_unverified` or
`unverified`; otherwise it reports `unsupported_numeric_claim` and the normal
repair / salvage / fallback path runs.

A sentence may still state a risky value when it explicitly says the value is
unverified or must be checked against the cited page. Bare words such as
"OCR" or "verification" no longer count as that warning, because they also
occur in ordinary order subjects. Leading list numbering ("1.", "2)") is
treated as formatting rather than a numeric claim.

Follow-up detection is narrower: Hindi conjunctions (और, तो, लेकिन, अगर ...)
only signal a follow-up at the start of a question, "यह/वह" only when followed
by a document noun, and English "that" only when it refers to an order, rule
or similar. This stops standalone questions inheriting the previous source.

## ADR-043 - Legacy-font garble counts as suspicious; display time zone is configured

Some native PDFs were produced from legacy (Krutidev-style) fonts through a
broken ToUnicode map: U+200D appears where spaces belong, U+0904 "ऄ" replaces
"अ", and letters are dropped ("पंप" becomes " म्"). The old ratios scored some of
these pages above the selective-OCR threshold, so only part of such a document
was OCR'd and Hindi questions about it failed validation. The shared scorer now
penalises dense zero-width joiners (>=20 and >2% of Devanagari characters) and
U+0904, which puts those pages first in `compare:suspicious`. That script now
skips pages that already have an OCR file (`--redo` to include them), accepts
`--max` up to 500 and merges its report across runs.

Dates are shown in a configured zone (`NEXT_PUBLIC_APP_TIME_ZONE`, reports:
`APP_TIME_ZONE`, both default `Asia/Kolkata`); storage stays UTC.

## ADR-044 - Departments are matched by Shasanadesh department ID, not only by name

Older captures name departments in English ("Agriculture"); portal captures
use the listing's Hindi name ("कृषि विभाग"), sometimes with zero-width joiners.
The Shasanadesh ID ("sequence#departmentId#section#year") carries the same
numeric department ID for both. Therefore:

- the department filters in the retrieval service strip joiners and widen a
  name match to every document sharing that name's `department_id`, so a
  profile scoped to "Agriculture" also finds कृषि विभाग orders (chat and Search);
- the Search page groups orders by department ID and shows every spelling seen
  ("Agriculture · कृषि विभाग"); other collections group by department name or,
  when there is none, by archive.

Portal listing dates (`DD/MM/YYYY`, day first) are converted to ISO for
`documents.go_date` so date filters cover portal captures; the raw value stays
in `documents.metadata`. Portal captures use the order's subject as the
document title shown in results.

A bilingual department registry (one canonical record per department ID with
English and Hindi names) is still to be built; until then the profile picker
can list both spellings.

## ADR-045 - Browsing is a metadata listing, separate from semantic search

Officers also need the portal's kind of search: "everything from this
department/section between these dates", complete and countable. Semantic
search cannot give that (it returns the top reranked pages, not all matches),
so the Search page's default tab lists orders straight from the `documents`
table with exact filters, a total and pagination. Department choices are keyed
by Shasanadesh department ID (ADR-044). The listing includes orders whose text
is not indexed yet and marks them, so archive coverage is visible before
embedding catches up.

## ADR-046 - Orders are classified before heavy processing; Ask leaves out confident routine orders

Most Shasanadesh orders are routine or individual (on 1,025 listings: ~38%
financial sanctions/releases, ~57% one person, place, project, company or case).
They are useful to the few people concerned, who use the portal, but they drown
the generally applicable guidance officials need in Ask.

- `npm run classify:orders` assigns a document type and a tier from the listing
  (subject first, portal category as a weak hint; `src/classify/rules.ts`), writes
  `data/corpus/classification.jsonl`, and applies human corrections from the
  tracked `datasets/classification-overrides.jsonl`. `db:load` copies it into
  `documents.doc_type / tier / classification` (migration 007).
- Tier A = generally applicable, B = useful in context, C = routine/individual.
- Heavy steps (`ocr:needs`, `compare:suspicious`, `build:retrieval-variant-chunks`
  → embeddings) skip tier C with high confidence; `--include-routine` overrides.
  PDFs and metadata are still archived in B2 and browsable.
- Chat retrieval excludes tier C with high confidence (`include_routine=false`);
  low-confidence C stays in until reviewed. The internal Search tab and explicit
  source-ID lookups include everything. With a filter present, pgvector ≥ 0.8
  iterative index scans are enabled so filtered vector search still fills LIMIT.
- Nothing is deleted; tiers are settings that can be corrected.

Answer source cards carry a "Copy reference" line (e.g. "शासनादेश संख्या …,
दिनांक DD.MM.YYYY") built only from recorded metadata, and an "Official copy"
link to the issuing site.

## ADR-047 - Relevance gate; profile departments are a preference, not a wall

Observed 26 Sept: "medical officer seniority …" asked by an officer whose profile
had Secondary Education, Public Works and Agriculture returned only Agriculture
pages. The model then wrote "the evidence does not contain …", the validator
forced citations onto that sentence, and two unrelated orders were shown.

- **Relevance gate** (`src/rag/relevance.ts`): reranker scores are mapped to 0–1
  (probabilities pass through, logits get a sigmoid). Direct pages below
  `RAG_MIN_RELEVANCE` (default 0.1) are dropped, with their neighbour pages.
- **Scope fallback:** if nothing relevant remains within the profile's
  departments, the question is searched once across all departments and the
  answer is badged "Searched all departments". Explicit source/department
  requests are not widened.
- **"Not found" is an answer:** with no relevant page, or when the model replies
  `NO_ANSWER_IN_EVIDENCE` (new prompt rule), Ask returns a fixed Hindi/English
  message, no citations and no source cards (`done.noEvidence`).
- **Sources:** after an answer completes, only cited orders are shown; other
  retrieved orders sit behind "N other retrieved orders (not cited)".
- **Department picker:** one choice per Shasanadesh department ID (English name
  preferred), plus names already on profiles; retrieval widens any spelling by
  department ID (ADR-044).

The threshold is uncalibrated; the answer's latency panel shows "Best match" so
good and bad questions can be compared before tuning it.
