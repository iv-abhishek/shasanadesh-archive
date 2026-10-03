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

## ADR-048 - Answers never end mid-word; Hindi gets a larger token budget

26 Sept: a correct Hindi answer ended "… कार्य की विशिष": the repair pass was capped
at 450 tokens and Devanagari uses several times more tokens per word than English
(the first draft's 900 also cut the solar-pump answer). Now:

- Hindi questions use `LLM_MAX_TOKENS_HI` (default 1800), English `LLM_MAX_TOKENS` (900);
  the repair pass gets the same budget unless `LLM_REPAIR_MAX_TOKENS` caps it.
- When generation stops with `finish_reason = length`, the text is cut back to its last
  complete sentence or bullet, a dangling "…निम्नलिखित शर्तें दी गई हैं:" lead-in is dropped,
  and the answer is badged "Shortened" (`done.shortened`). Validation runs on the trimmed text.
- The prompt asks for concise answers (about 6 bullets / 200 words), which also keeps
  generation time down on the laptop.

## ADR-049 - A citation after the full stop belongs to its sentence

26 Sept: a Hindi answer came back as five bullets of bare "[S1 p.1]". The model
wrote "…दी गई है। [S1 p.1]"; the claim splitter cut after "।", so each sentence
looked uncited (validation failed → salvage) and salvage kept the citation-only
fragments. Now citation-only fragments are merged into the preceding claim unit,
salvage keeps only units with at least three words besides citations, and an
answer that is only citations fails validation as `empty_answer` (then repair or
the safe fallback runs).

## ADR-050 - Broken-conjunct native text is suspicious; Ask has a regression set

While writing evaluation cases (26 Sept) the native text layer of most Shasanadesh
PDFs turned out to drop conjuncts: "प्रसूति" → "सूित", "उत्तर प्रदेश" → "उ तर दे श",
leaving words that start with a vowel sign, which real Hindi never does. About 190 of
196 indexed native pages showed it, yet scored 60–70 (above the selective-OCR cut-off),
so they were never OCR'd and keyword/semantic retrieval on them is weak.

- `analyzeTextQuality` now counts words starting with a dependent vowel sign or mark;
  at >= 3 such words and >= 1% of words the score drops by 15–45 points, so
  `compare:suspicious` OCRs these pages. Retrieval already reranks native and OCR
  variants and keeps the better one; the native layer is kept (its digits are useful
  for numeric verification). The Search console's garble note uses the same signal.
- `eval/rag-cases.json` grows to 24 verified cases, and the runner checks "not found"
  behaviour, profile-scope fallback, text-less and cut-off answers, and reports a
  suggested `RAG_MIN_RELEVANCE` (`npm run eval:ask`).

## ADR-051 - Unchecked draft preview while answering; hosted generator switch

Answers take 60–150 s on the laptop, all of it spent before anything appears,
because the answer is released only after validation. Now the first draft streams
as SSE `draft` events into a muted box labelled "Draft — being checked against the
cited pages" (Hindi label for Hindi drafts); the validated answer replaces it and
only the validated text is saved, copied or read aloud. The preview holds back a
leading `<think>` block and anything that may be `NO_ANSWER_IN_EVIDENCE`
(`src/rag/draft-preview.ts`). `RAG_STREAM_DRAFT=0` restores answer-only output.

For hosted models, generation skips the local GPU queue when `LLM_BASE_URL` is not
localhost, `LLM_EXTRA_BODY` passes provider options (e.g. disabling Qwen3
thinking), and a leading `<think>` block is stripped from the final text.

## ADR-052 - Per-department portal capture with reconciliation; routine originals only in B2

The first capture (26 Sept) used one all-departments, date-sorted listing: 11 pages
held 1,100 rows but only 1,025 unique orders, so rows were repeated and, by the
same mechanism, skipped. Pasting ~1,776 pages by hand was also impractical.

- The bridge records every page under a **listing** (the portal search filters:
  department, section, category, dates). Page numbers are per listing; a listing is
  complete only when pages 1..ceil(total/page size) are captured and rows reach the
  portal total. Pages that come back with different orders are logged as reshuffles
  (new orders kept, page not double-counted). Earlier pages belong to "legacy".
- A **capture bookmark** (served by the bridge with a per-run token) reads the
  results table by its Hindi/English headers, the current page, the total and the
  filters, and POSTs to the bridge; CORS/Private-Network headers allow only the
  portal origin. Fallback: copy + paste. The CAPTCHA remains a person's step.
- `npm run portal:report` reconciles listings, downloads, B2 and disk use.
- The importer gains `--until-idle`. Orders the classifier is confident are routine
  (tier C) have their local `original.pdf` removed once B2 holds the same bytes
  (sha256); metadata and text stay, and the viewer falls back to the official link.
  `--keep-routine-local` opts out; `--evict-existing` applies it to earlier downloads.

## ADR-053 - Classification pass 2 (model) and human review in the console

- `npm run classify:model` sends the orders the rules were unsure about (confidence
  "low") to the configured generator with a fixed tier/type definition and stores
  JSON verdicts in `data/corpus/classification-model.jsonl` (resumable; unusable
  replies are discarded). `classify:orders` now applies: human override > model >
  rules, and records `decidedBy`.
- The archive console's rows have A/B/C buttons. `POST /api/documents/classification`
  updates `documents.tier/doc_type/classification` at once and appends the correction
  to the tracked `datasets/classification-overrides.jsonl`, so it survives the next
  `classify:orders` + `db:load`. Refused in production unless `ARCHIVE_CONSOLE_WRITE=1`
  (no admin sign-in yet).

## ADR-054 - Links between orders: "later changed by" on answers and source cards

Officials cite orders in letters, so an answer that quotes an order that was later
amended or superseded is a real risk (ROADMAP Phase 3, "Relationships").

- `npm run relations:build` (`src/build-relations.ts`, `src/relations/extract.ts`) reads
  each order's portal subject and **native** page text (OCR digits are unreliable, so OCR
  text is not used) and extracts references to other orders: GO number + date, and the
  kind from nearby wording: `supersedes` (अतिक्रमण / in supersession of), `amends`
  (संशोधन / amendment), `cancels` (निरस्त / rescind), `corrects` (शुद्धि-पत्र /
  corrigendum), else `refers`. The order's own header is skipped. Tolerant patterns
  cover the broken conjuncts of legacy-font text.
- An order is identified by a **number key** (serial + first 4-digit year, e.g.
  `160/2012` for `160/दस-2012-216/79`) plus the ISO date; this survives the many ways a
  GO number is written. Output: `data/corpus/relations.jsonl` (derived).
- `db:load` replaces table `document_relations` (migration 008) from that file. No
  foreign key: either side may be listed but not yet archived.
- At answer time (`src/rag/later-changes.ts`) relations are matched to evidence orders by
  resolved ID **or** key + date, so links resolve as more orders arrive. Only the four
  change kinds are used; `refers` is kept for later (e.g. "orders this one relies on").
- Prompt: evidence blocks get a digit-free `LATER_CHANGES=` line ("amended by SOURCE S2"
  or "… by a later order that is not in this evidence"). The model says in one cited
  sentence that the order was changed and must not present a superseded provision as
  current. It never writes the later order's number, because the numeric validator only
  accepts numbers found on cited pages.
- UI: the source card shows "⚠ Amended by GO … dated …" linking to the official copy of
  the later order (exact values come from metadata, not from the model).
- Limits: absence of a link does not mean an order is in force; links depend on the later
  order being captured and having native text or a descriptive subject. First run on the
  local corpus: 46 references (1 amends, 2 corrects), 2 matched.

## ADR-055 - Daily sync: one script, launchd on the Mac for now

- `scripts/daily-sync.mjs` (`npm run sync:daily`) runs, in order: db:check,
  [ingest:sources, ingest:portal --until-idle], classify:orders, ocr:needs, build:pages,
  compare:suspicious --max 150, build:retrieval-variants, build:retrieval-variant-chunks,
  relations:build, db:load, embed:chunks, portal:report. Each stage is already
  incremental (existing OCR/pages are skipped; embeddings fill `embedding IS NULL`).
- A failure in a stage that later stages depend on stops the run; OCR, relations,
  ingestion and the report are non-critical and only warn. Every run writes
  `data/sync/reports/<date>.md` + `.json` and per-step logs, and posts a macOS
  notification. A lock file prevents overlapping runs (taken over after 12 h).
- **Fetching is opt-in** (`--ingest` / `SYNC_INGEST=1`) while ingestion is on hold. The
  portal side stays person-started: someone captures the newest listing through the
  bridge (CAPTCHA by hand); the job only downloads what was captured.
- Scheduling: `scripts/install-daily-sync.sh` writes a launchd agent
  (`in.shasanadesh.daily-sync`, 02:30 local by default, background priority). launchd
  runs a missed job after wake. Projects under `~/Downloads` need Full Disk Access for
  `node` (macOS privacy). On a future server the same script runs from cron/systemd.

## ADR-056 - Local disk: B2 is the archive, the Mac keeps a working cache

Measured on 27 Sept (680 orders): tier C orders use 660 KB each, almost all of it the
original PDF; tier A orders 4.7 MB each, mostly OCR page images (300 dpi PNGs, ~1 MB per
page) that nothing reads after OCR. Keeping everything for 177,504 orders would need
~140 GB and grow without limit.

- Every order keeps `metadata.json` and extracted text locally (classification, links,
  browse). The original PDF stays locally only for orders the processing gate processes
  (tier A/B or unsure), since OCR and rebuilds need it; routine originals live only in B2.
- `ocr:needs` deletes each page image once its text is written.
- `npm run storage:trim [-- --apply]` removes leftover OCR images and routine originals.
  An original is deleted only when its local bytes match the SHA-256 recorded for the B2
  copy; metadata records `localCopy: evicted`. Dry run by default.
- `npm run storage:restore -- --needed | --source-id <id>` downloads originals back from
  B2 (by file ID, SHA-256 checked) when a tier is corrected to A/B. Needs `readFiles`.
- `ingest:portal` and `ingest:source*` stop before free space drops below
  `MIN_FREE_DISK_GB` (default 40; measured with `df -Pk`, correct on macOS and Linux).
- The daily sync runs restore (after classify) and trim (after embeddings) and ends with
  `storage:report`.
- Projection with the current tier mix: ≈ 15 GB of order files for the full portal, plus
  Postgres (text, chunks and embeddings of tier A/B only), a few GB.

## ADR-057 - Order lists for "recent / dated" questions; bilingual department registry

27 Sept: "recent government order release in department of basic education" returned an
unrelated Agriculture page and a safe fallback. Semantic search cannot rank by date,
"basic education" did not match the archive's Hindi name (बेसिक शिक्षा विभाग), so the
search stayed in the profile's departments.

- **Order lists** (`src/rag/order-listing.ts`): a question that mentions orders and
  either a recency word (recent, latest, new, issued, released, हाल, नवीनतम, जारी …) or a
  date (today, yesterday, this/last week, this/last month, last N days, a month, a year,
  a day such as 21.09.2026 / 21 Sept 2026, between A and B, since A — English and Hindi,
  IST calendar) is answered from the order list: newest first, up to 10, "N of total",
  each line date · GO number · subject with a source card (Copy reference, official
  link, later changes). No model is involved, so it is instant and every line is a
  recorded fact. Questions about content ("what does…", procedure, eligibility,
  provisions) still go to Ask. Leftover subject words filter the subjects; when nothing
  matches, the question goes to Ask instead of listing unrelated orders.
- Scope: a named department; otherwise the profile's departments; if they have nothing,
  all departments (flagged). All tiers are listed: the question is what was issued.
- **Department registry** (`datasets/departments.json`, `src/departments/registry.ts`):
  Shasanadesh department ID → portal Hindi name, English name (from the archive or a
  standard translation marked `enSource: translation`, to review) and aliases (PWD,
  jail, बेसिक शिक्षा). A mention is *strong* when multi-word or followed by
  department/विभाग and then also scopes Ask, through a new retrieval filter by
  department ID (`department_ids`), independent of how captures spelled the name. A
  single word ("finance", "energy") is *weak* and only used for lists.
- UI: list answers carry an "Order list" badge; their source cards drop the text-quality
  badge. A safe fallback no longer shows "Validated".
- Eval: two `order-list` cases (`expectListing`).
- Dates also cover several days ("10th or 15th September", "10 और 15 सितम्बर",
  "10.09.2026 or 15.09.2026"; listed day by day, empty days reported), month-first dates,
  a missing year (the last such day that has passed) and misspelt months next to a day
  ("Sepetember"; within 1–2 edits of the name). A department named twice ("Public Works
  Department or PWD") is one department, not a subject word.

## ADR-058 - Find any order from Ask

Abhishek (27 Sept): Ask should also find orders — by phrase or sentence, GO number, date,
subject, department, issuing office and wildcard text. The internal Search page stays for
the team; end users only have Ask.

- **Parsing** (`src/rag/order-listing.ts`): quoted phrases (exact), wildcard terms (`*`
  any run, `?` one character inside a word), a GO number (serial/…year…, spaces ignored;
  "51/2026" finds every 51/2026/…), the issuing office ("released/issued by …",
  "… द्वारा जारी", "… अनुभाग-5", "section 1" → अनुभाग-1), the department (registry,
  ADR-057; a one-word name next to other words is a subject word, so "work from home" is
  not the Home department), dates (ADR-057) and the remaining subject words.
- **When it is a search**: a find verb (find/search/खोजें…), a GO number, quotes, a
  wildcard or an issuer makes it explicit; otherwise a question that mentions orders and
  is not about their content ("what does…", procedure, eligibility, how much…, "what is
  the <thing>") is treated as a search, and falls back to Ask when nothing matches.
- **Matching**: every term must appear in subject, section, category or GO number
  (sections match by regex, ignoring dash/spacing but not the number). Word matches are
  listed newest first. When there are fewer than 10, orders whose **subject is close in
  meaning** follow as a separate group: `embed:subjects` stores one Qwen3 vector per
  order (subject + department + section + category, all tiers; table
  `document_subject_embeddings`, migration 009) and the retrieval service's
  `/subjects/search` returns the nearest (cosine ≥ FIND_MIN_SIMILARITY 0.45 and within
  0.12 of the best; uncalibrated, `bestSimilarity` is in the done event). This is what
  lets English words find Hindi subjects.
- **Scope**: a named department, otherwise all departments (a search is not limited to
  the profile; "recent orders" without a department still uses the profile).
- **Answer**: the ADR-057 list with the criteria in the heading ("Orders matching GO
  number “51/2026…”, section “…” — Public Works, this week"), meaning matches under "Also
  close in meaning", and a clear "no order found" with hints for explicit searches. The
  badge reads "Order search".
- **Not possible from the data**: the signing officer's name is not recorded in the
  portal listing, so "signed by <name>" is matched as text only.

## ADR-059 - Stop an answer

A person who changes their mind should not wait for a 30–60 s answer, and on the Mac
a forgotten answer holds the GPU queue for the next question.

- While an answer is in progress the send button becomes **Stop** (square in a spinning
  ring); **Esc** does the same unless a dialog is open. The browser aborts its request;
  the turn shows "Stopped. The answer was not finished." with Retry, nothing is saved,
  and the question returns to the input box (unless something new was typed) so it can
  be edited and sent again.
- The web proxy passes the browser's abort to the API (`signal: request.signal`).
- The API aborts on the response `close` event when the stream had not finished:
  retrieval `fetch`es and the model stream are cancelled (`signal`), work waiting in the
  local GPU queue does not start (`throwIfAborted`), and because the OpenAI SDK ends a
  cancelled stream quietly, `generateCompletion` checks the signal after the loop so a
  half-written draft is never validated or repaired. A stopped request is logged, not
  reported as an error. Checked with a fake streaming model: the model connection closes
  within the stop.
- Also: wildcard stems (`*solar*` → "solar") take part in meaning-based subject matching.

## ADR-060 - Start page and search guide

The empty Ask screen showed two "benchmark" chips. With Ask now answering, finding and
listing orders (ADR-057/058), people need to see what they can do and how to search.

- Start page (`apps/web/components/start-panel.tsx`): a bilingual headline, three task
  cards (Ask a question · Find an order · Latest and dated orders) with ready examples,
  and the search guide. Examples fill the input box and focus it, so they can be edited
  before sending; nothing is sent by a click.
- Search guide: `"…"` exact phrase, `*` any letters, `?` one letter, GO number (or its
  beginning), issuing section (released by … / … द्वारा जारी / … अनुभाग-1), dates (today,
  this week, last month, August 2026, 10.09.2026, 10 or 15 September, पिछले सप्ताह),
  departments in English or Hindi; each row has a clickable example, and a note on
  combining terms and on when Ask writes an answer versus lists orders.
- The same guide opens from a "?" button beside the input during a conversation (a
  dialog above the composer; Esc or a click outside closes it, and Esc there does not
  stop an answer). Placeholder: "Ask a question, or find an order by number, subject,
  department or date…".
- Built on the existing colour tokens (light and dark), one column under 900 px, no
  horizontal scroll at 390 px; chips use the UI typeface because monospace fonts have
  no Devanagari.

## ADR-061 - Hinglish typing becomes Devanagari (HI input)

Officials often type Hindi in English letters ("solar pump lagwane hetu kya prakriya
hai"). Only voice input produced Devanagari. The archive is mostly Devanagari, so
Hinglish questions also retrieve worse.

- The EN/HI switch beside the input now sets the input language for voice **and** typing.
  With HI, a word typed in English letters becomes Devanagari when it is finished (Space
  or punctuation): सोलर पम्प लगवाने हेतु क्या प्रक्रिया है. Backspace right after a
  conversion restores the English letters; Enter converts the last word before sending.
  Acronyms in capitals (GO, PWD, DA), numbers, GO numbers and wildcard terms stay as typed.
- A bar under the input shows the best spellings for the word being typed, completions,
  and the English letters ("keep English"); clicking one puts it in place.
- **All in the browser; nothing is sent anywhere** (`apps/web/lib/transliterate.ts`).
  Candidates: fixed Hinglish spellings (mein → में, nahi → नहीं), then a lexicon matched
  by the words' casual romanisation (exactly; then ignoring "a", which people vary most;
  then consonants only, same first letter and similar length), then phonetic rules
  (conjuncts, nasal before a consonant, final a/i long as Hinglish writes them).
- Lexicon = ~300 everyday and administrative words (bundled) + every well-formed word from
  portal subjects, OCR output and native text that passes the text-quality check
  (`npm run translit:lexicon` → `apps/web/public/translit/hi-lexicon.json`, generated, not
  in git, rebuilt nightly). The archive's own spelling wins (e.g. पम्प), which also
  matches the subjects in search. First build: 4,506 words (most native text is
  legacy-font and skipped; OCR will add more).
- Not a language model: unusual names or English loanwords may need the bar or Backspace.

## ADR-062 - Curated core rules collection

Officials cite a small set of rulebooks and standing orders daily (GFR, DFPR, the
procurement manuals, GeM terms, UP Budget Manual, conduct rules, UP GeM orders). Most
are not on Shasanadesh, and those that are cannot be crawled there.

- `datasets/core-rules/catalogue.json`: a hand-reviewed list, one entry per document:
  official page, direct HTTPS PDF on a `.gov.in`/`.nic.in` host, issuer, jurisdiction,
  department, document type, edition/date, GO number, provenance note; optionally the
  Shasanadesh GO it copies (`preferredSource`) and entries it amends. Aggregator copies
  are never sources. Only current editions (Works 2nd ed. 2025, Consultancy 2nd ed. 2025
  and the new Non-Consultancy manual replace the 2022 manuals).
- Adapter `core-rules` (`src/sources/core-rules.ts`) only reads the catalogue (validated:
  HTTPS, government host, unique slugs, ISO dates, known `amends` targets); the shared
  importer downloads (politely, robots.txt), stores in B2 `archive/core-rules/`, extracts.
- Classification: provider `core-rules` → tier A, high confidence, type from the
  catalogue. Retrieval: department and profile filters never exclude core rules
  (they apply to every department). Catalogue `amends` become order links (ADR-054).
- First batch (15): GFR 2017 (to 31.01.2026), DFPR 2024, Goods 2024, Works 2025,
  Consultancy 2025, Non-Consultancy 2025, GeM GTC 4.0 v1.26, Make in India order
  (19.07.2024), UP Budget Manual, UP Conduct Rules 1956, five UP GeM GOs (2017–2025).
  Next candidates and the Shasanadesh capture list: `datasets/core-rules/README.md`.
- 27 Sept (later): +10 central documents from Abhishek's list, each checked on the
  issuer's site (arbitration & mediation OM 2024, Union Budget Manual 2022, DPDP Act 2023 and
  Rules 2025, CERT-In Directions 2022 and government-entity guidelines 2023, GIGW 3.0, Open
  API and Open Source policies, Open Data License 2017); 25 in all. Catalogue topics use the
  topic codes (ADR-064) and are validated. Documents on script-rendered sites (CVC, CGA,
  DARPG, DoPT, India Code) wait until their file URL is confirmed.

## ADR-063 - Permanent rules: government URLs only in chat; government sources only

Abhishek (27 Sept): the chat must never reveal that we hold the data (only government
URLs), and nothing may be ingested from a private site. Both are recorded as permanent
rules in `docs/RULES.md` (§1, §2) and enforced in code:

- §1: `officialOnly` for every source URL the API sends; `stripNonGovernmentLinks` on the
  answer and draft text; prompt rule; citations open the official copy at the cited page
  in a new tab (the archived-PDF viewer is removed from the chat); no internal IDs on
  source cards, in order lists or in "Copy answer". `/api/rag/pdf` stays for the internal
  Search page only.
- §2: `src/lib/government-hosts.ts` (`*.gov.in`, `*.nic.in`, reviewed exceptions such as
  CERT-In); enforced in `politeFetch`, `ingest-source` (download + redirect) and the
  core-rules catalogue. Migration 010 adds `documents.provenance_ok`; `db:load` sets it from
  the source host and the audit (`npm run sources:audit`, nightly); retrieval, subject
  search and the order finder exclude flagged documents. First audit: 1,050 documents,
  0 flagged.

## ADR-064 - Central + UP grouping (jurisdiction, authority, topics, status)

Abhishek (27 Sept): the archive is no longer Shasanadesh only; Shasanadesh is the UP part.
Central and UP documents now, other states later, all from government sources.

- Migration 011: `jurisdictions` (IN, UP; one row per future state) and `topics` (24 topic
  groups, bilingual names) tables; `documents.jurisdiction_code`, `authority`, `topics[]`,
  `status` (current/superseded/draft/historical), `edition`.
- Filled by `db:load`: jurisdiction from metadata (`jurisdiction: central` → IN, a future
  `stateCode` wins, else UP); authority = central issuer or UP department; edition and draft
  status from the core-rules catalogue; `superseded` when a later order supersedes or
  cancels it (order links). Topics from `src/classify/topics.ts` (bilingual subject rules;
  catalogue topics for curated documents), stored by `classify:orders`. On the 1,025 listed
  orders 98% get a topic.
- Retrieval returns jurisdiction and status; evidence blocks carry `JURISDICTION=` and
  `STATUS=` and the prompt states applicability (a Government of India rule does not by
  itself bind UP departments; superseded and draft documents are named as such). Source
  cards show "Government of India" / "Uttar Pradesh" and Superseded/Draft.
- Filters: retrieval `jurisdiction_codes` / `topics`; a question naming one government
  ("central government …", "UP …") is answered from that jurisdiction. The order finder
  turns topic and jurisdiction words into filters ("GeM guidelines", "central procurement
  rules", "पेंशन से संबंधित शासनादेश"); "केन्द्रीय कारागार" (a central jail) is not the
  central government. The Search console has Government and Topic filters with counts.

## ADR-065 - Suggested follow-up questions under an answer

Abhishek (27 Sept): after an answer, offer a few relevant questions to click.

- The browser asks `POST /api/suggest` (web proxy `/api/rag/suggest`) **after** the answer is
  shown, so suggestions never delay the answer. Only the latest answer gets them; not
  archived chats, "no matching order", safe fallback or small talk.
- Answers from text: the model writes three short questions in the answer's language from the
  question, the answer (citations removed) and the cited orders' titles, GO numbers and
  dates (160 tokens, temperature 0.4, `src/rag/suggestions.ts`). The reply is cleaned: no
  URLs (Rulebook §1), no repeat of the question, wrong-language lines dropped, max three.
- Order lists: deterministic ("What does GO 51/2026 dated 21.09.2026 say?").
- Fallbacks: fixed questions (procedure, competent authority, later amendments) when the
  model is off (`RAG_SUGGESTIONS=0`), fails, returns fewer than two, or another question is
  waiting for the local GPU (a person's answer always comes first).
- Clicking a chip asks it as the next question in the same conversation.

## ADR-066 - Auto-archive conversations after a month without activity

Abhishek (27 Sept): chats older than one month go to Archives automatically, date-wise.

- Migration 012: `conversations.archived_at`, `archived_reason` ('manual' | 'inactive'),
  `restored_at`. Activity = last message or rename (`updated_at`) or last restore, so a
  restored chat gets a fresh month. Pinned chats are never auto-archived.
- Applied lazily whenever a person's history loads (best effort; before migration 012 it is
  skipped with a warning) and for everyone by `npm run chats:archive`, a step of
  `sync:daily`. `WORKSPACE_ARCHIVE_AFTER_DAYS` (default 30; 0 = off).
- The Archived view groups by month of last activity, then by day; automatically archived
  rows say so on hover. Opening an archived chat only views it; Restore continues it.

## ADR-067 - Files a site will not let the ingester fetch

First core-rules run (27 Sept): 18 of 25 stored; GeM (`assets-bg.gem.gov.in`) and the UP
S3WaaS CDN (`cdn.s3waas.gov.in`) disallow these paths in robots.txt, and dea.gov.in did not
answer. The ingester keeps obeying robots.txt. Instead a person opens the official link
and saves the PDF as `data/manual-downloads/<adapter>/<sourceId>.pdf`; the next run uses
that file, checks it is a PDF, records `capture.method: "manual-download"` and keeps the
official URL as `sourceUrl` (Rulebook §1/§2 unchanged: the source is still the government
URL). Each run lists refused or unreachable files in `NEEDED.md` in that folder.

`dev:all --restart` also stops a Next.js dev server that holds `apps/web/.next/dev/lock`
without serving the port (the cause of "Another next dev server is already running").

## ADR-068 - Ministry websites on the common government CMS (gov-cms adapter)

Abhishek (28 Sept) asked for the MSME ministry's "Orders and Notices" archive
(सूक्ष्मलघुऔरमध्यमउद्यममंत्रालय.सरकार.भारत). Many ministries now run the same site platform
(Next.js front end, WordPress back end): the page is rendered by script, but its public
JSON (`/cms/wp-json/document/documents?document_category=…&post_status=publish|archive`,
then `post-page/post?id=<file id>` for the attachment) gives every document and its PDF on
the ministry's own host (msme.gov.in/static/uploads/…). No key or login is needed.

- `src/sources/gov-cms.ts` + `datasets/gov-cms/sites.json`: one adapter per configured
  ministry (`gov-cms-<site>`, its own B2 collection); categories and statuses per site.
  First site: MSME, orders-and-notices, current + archive = 42 PDFs (incl. the MSMED
  (Amendment) Act, 2026 of 21.09.2026 and the MSE procurement review committee minutes).
- Documents go through the normal classification, so narrow items (appointments,
  transfers, CPIO lists) are archived but kept out of answers.
- `.सरकार.भारत` (punycode `.xn--11b7cb3a6a.xn--h2brj9c`) is added to the government suffixes
  (Rulebook §2): it is the Hindi-script equivalent of `.gov.in`.
- This is the base for PLAN §0-C (department knowledge): adding a ministry on the same
  platform is a sites.json entry (other categories: acts-and-policy, guidelines,
  gazettes-notifications, reports).

## ADR-069 - UP Financial Handbook: HTML volumes read page by page, cited at their own URL

The Financial Handbook (वित्तीय हस्तपुस्तिका), the most-used UP rulebook, is published by the
Finance Department on budget.up.nic.in mostly as web pages, not PDFs (checked 1 Oct 2026;
no official PDF of these volumes exists; copies on document-sharing sites are not
government sources, Rulebook §2).

- `src/sources/up-fhb.ts` + `npm run ingest:handbook` (`src/ingest-handbook.ts`): Vol. II
  Parts II–IV (Fundamental and Subsidiary Rules), Vol. III (TA rules), Vol. V Part I
  (account rules), Vol. V Part II (treasury rules), Vol. VII (Forest accounts) and the Civil
  Service Regulations. One document per volume (`up-fhb-<volume>`, provider and B2
  collection `up-fhb`); each chapter page becomes text and is split into parts of at most
  3,500 characters at paragraph boundaries, each headed with volume and chapter.
- **Citations**: `metadata.pageUrls[i]` is the official URL of page i+1; the retrieval
  service returns it as `page_url`, so a citation opens the exact chapter page on
  budget.up.nic.in instead of `#page=N` (Rulebook §1).
- The pipeline treats these like PDFs without a PDF: `build:pages` reads
  `html-pages/page-NNN.txt`; `storage:restore` skips them; the raw HTML of every chapter
  is archived in B2 as one `raw.html.json` bundle (b2.ts gained `rawExtension`).
- A volume is replaced only when every page was read; a 404 in the official index (Vol. V
  Part II "030.HMT", Vol. II chapters 6 and 53 published as .doc and now missing) is
  recorded in `html.skippedLinks`. Unchanged text does not create a new capture. The daily
  sync re-reads a volume after 30 days.
- Classified tier A (rulebook) like the curated core rules.
- Vol. VI (PWD/irrigation accounts) is chapter PDFs (scanned → OCR) and goes through the
  core-rules catalogue (`incoming/2026-10-01-up-financial-handbook.json`), as do the 24
  chapters of **Vitta Path** (वित्त पथ, budget.up.nic.in/vittapath), the Finance
  Department's 2012 guide to financial and service rules (delegation of financial powers,
  leave, pay fixation, store purchase, pension, GPF, office procedure…). Vitta Path is
  typed "guideline", titled with its year, and its note says later rules prevail. Missing
  on the site (404): Vol. VI chapters 18, 20, 21 and Appendix IV; Vitta Path chapter 13
  (medical reimbursement). Vol. I (delegation of financial powers) is not online.

## ADR-070 - Kruti Dev text converted to Unicode when pages are built

Vitta Path and many older UP documents were typed in the Kruti Dev font: the PDF text layer
holds Latin codes ("foŸkh; vf/kdkj" for "वित्तीय अधिकार"), which the text-quality checks do not
flag (they look for broken Devanagari) and which search and the model cannot use.

- `src/lib/krutidev.ts`: exact mapping (longest sequence first, then the short-i and reph
  re-ordering), including the alternate glyph slots these PDFs use (त्त, ो, ौ, ध्, भ, ०), the
  rupee sign, digit separators, and English phrases typed in a Latin font inside the Hindi
  text ("(Standards of Financial Propriety)" stays English).
- `looksLikeKrutiDev` is strict (Kruti Dev function words must clearly outnumber English
  ones, little real Devanagari); on a 400-order Shasanadesh sample it flagged nothing (those
  are Unicode) and on the English Handbook it flagged nothing.
- `build:pages` converts a native page that looks like Kruti Dev; the page record says
  `converted: "krutidev"` and `pageCorpus.krutiDevPages` counts them. Conversion is exact
  for the font, so it is preferred to OCR; OCR remains the fallback for scans.
- `ingest:source` now copies corrected catalogue details (title, type, topics) onto
  documents already stored, so fixing a catalogue entry does not need a re-download.

## ADR-071 - Ask routing fixes from the first Handbook test (2 Oct 2026)

Abhishek's first questions after the Handbook load showed four routing faults:

1. **Rulebooks under a department scope.** A profile scope ("my departments") kept the
   core rules but dropped the Financial Handbook (provider `up-fhb`), so a Handbook
   question was answered from Vitta Path only. The retrieval scope now always includes
   both rulebook providers.
2. **"?" after a question.** "…आवश्यक है?\",?" was read as a wildcard pattern (an order
   search). A "?" is a wildcard only between letters ("क?षि").
3. **"इस आदेश" follow-ups.** "क्या इस आदेश में बाद में कोई संशोधन हुआ है?" was listed as a new
   search for orders containing "संशोधन". A question that names the document under
   discussion ("इस/उक्त आदेश", "this/the above order") skips the order finder; when it asks
   whether the document was amended, superseded or cancelled, the answer comes from the
   order links (`src/rag/document-followup.ts`, ADR-054 data), never from the model, and
   says the check covers the archive only.
4. **"संख्या … में क्या निर्देश है?"** A GO-number lookup also required the question's other
   words ("दिनांक", "निर्देश") in the subject and found nothing. A GO number now ignores
   them (and zero-width joiners); when the question asks what the order says, the order
   is found by number and Ask answers from that order's own pages. An order whose text is
   not indexed (routine) still gets its card with the official link.

Addendum (2 Oct 2026): 28 Handbook pages (government orders printed in Vol. III and Vol. V,
mostly Vol. V Part II) set their Hindi in Kruti Dev 010/020/040 fonts inside the HTML
(`<FONT FACE="Kruti Dev 020">`). The reader converts text inside such font tags
(`convertLegacyFontText`, up-fhb.ts) and leaves digits and English in other fonts alone;
inline font tags no longer insert spaces. `npm run ingest:handbook -- --reparse` re-reads
the saved pages without fetching and keeps the B2 capture.
Source cards now say so when a cited page's official copy is in a Kruti Dev font
(`metadata.html.legacyFontPages` for Handbook pages, `pageCorpus.krutiDevPages` for PDFs;
`legacy_font` on retrieval evidence): "the text here was converted; without that font the
official copy may look garbled".

## ADR-072 - Profile state and district from the Local Government Directory (2 Oct 2026)

Profiles took the district as free text ("Lucknow", "लखनऊ", "Lko"), which cannot scope
anything for district officials and breaks on renames. States/UTs and districts now come
from the Local Government Directory (LGD, Ministry of Panchayati Raj), the code list other
government systems use:

- `npm run ingest:lgd` (scripts/ingest-lgd.mjs) reads LGD's public web service
  (`lgdirectory.gov.in/webservices/lgdws` stateList / districtList: form POST, no key, no
  CAPTCHA; robots.txt and the 3 s crawl gap honoured; ~37 requests) into
  `datasets/lgd/lgd-states-districts.json` (36 states/UTs, 784 districts on 2 Oct 2026).
  The daily sync refreshes it when the copy is 30+ days old; the file is replaced only
  when every state was read. data.gov.in's CSV copies need a download form, so are not used.
- LGD's "local name" for UP districts is English, so Hindi names and former names
  (Allahabad → Prayagraj, Faizabad → Ayodhya, Noida, Lakhimpur Kheri, Sant Ravidas Nagar …)
  for all 75 UP districts are kept in `datasets/lgd/district-names-up.json`
  (hiSource: translation, to review) and merged by the script.
- The profile's state and district are search-and-pick fields (any spelling, Hindi or
  former name; district lists only the chosen state's). "Central Government / Other" has
  no district. The server stores the LGD names plus `state_lgd_code` /
  `district_lgd_code` (migration 013; profiles save names only until it has run).

Not yet: using the district in retrieval (district-specific orders, "orders for my
district") and block/tehsil levels; the codes are stored so that can be added without
asking officers again.

## ADR-073 - Profile scope widens when only rulebook pages match (2 Oct 2026)

"What are the seniority rules for medical officers?" from a profile scoped to Secondary
Education, Agriculture and Public Works answered from a Financial Handbook page on fees and
a Registration Manual page. Rulebook pages (core-rules, and since ADR-071 the Handbook) pass
every department filter, so the scoped search "found" pages that mention medical officers in
passing; the existing widening (ADR-062: search all departments when nothing relevant is
found) never ran.

- When everything kept from the profile-scoped search is rulebook or central material and
  none of it comes from the officer's own departments (any spelling, via the registry), the
  question is searched once more across all departments; the search with the better best
  relevance is used and the answer says it searched all departments
  (`hasEvidenceFromDepartments`, src/rag/relevance.ts). Cost: one extra retrieval for such
  questions only.
- Cadre words name their department: "medical officer(s)", "चिकित्सा अधिकारी",
  "चिकित्साधिकारी/-यों", "doctors", "प्रान्तीय चिकित्सा सेवा" are aliases of Medical and Health,
  so such questions are scoped there directly.

Content gap noted: the general Uttar Pradesh Government Servants Seniority Rules, 1991 are not
in the core-rules collection yet.

## ADR-074 - Order finder fixes from the 2 Oct test conversation

A 15-question test (conversation ce8e4950…) showed the finder failing on ordinary phrasing:

1. **English words vs Hindi subjects.** "Solar pump up GO" found nothing word for word and
   listed canal-top solar PV plants; subjects say "सोलर पम्प" / "कुसुम". A small curated
   glossary (`src/lib/finder-glossary.ts`, ~45 groups) lets each finder word and wildcard
   match its Hindi spellings ("solar" = सोलर/सौर, "pump" = पम्प/पंप), and adds those
   spellings to the meaning-based subject search.
2. **"<subject> के लिए उत्तर प्रदेश शासन द्वारा जारी …"** was read as section "सोलर पंप के लिए
   शासन". The issuer is now only the words after "के लिए / हेतु / के संबंध में …", and
   "शासन / उत्तर प्रदेश शासन / सरकार" means the government (no filter).
3. **"released by Ravi Ranjan".** "release by" was not recognised and the name became search
   words. The archive does not record who signed an order; a person as issuer is now
   reported as not searchable (with how to search instead), and any other criteria still run.
4. **"Agriculture, 15.09.2023"** (department + date, nothing else) lists that day's orders
   instead of going to Ask.
5. **"Agriculture अनुभाग 5"**: an English department name inside a section is replaced by its
   Hindi name ("कृषि अनुभाग 5"), since sections are named in Hindi.
6. **"*Solar पम्प*"**: a starred phrase containing a space is one pattern, not two.
7. Ask prompt: when the evidence does not state the asked fact, say so in one sentence and
   stop — no attributing it to another rule, no "as specified in the government orders"
   padding, no repeated points (the "time limit for documents" answer had linked the
   Seniority Rules).

Not changed: an explicitly named department still lets central guidelines rank first
("solar pump subsidy - agriculture department" answered from the PM-KUSUM national
guidelines); worth revisiting with the quality pack.

## ADR-075 - Hosted answer-writing on OpenRouter, local Qwen as fallback (2 Oct 2026)

On the 16 GB Mac, answers took 30 s to 5 min (swap; one Hindi answer 309 s of generation).
Answer-writing moves to an OpenRouter Qwen model (HOSTING.md pilot plan); retrieval stays local.

- `LLM_PROVIDER=openrouter` + `OPENROUTER_API_KEY` (+ `OPENROUTER_MODEL`, default
  `qwen/qwen3.6-35b-a3b`, about $0.15 in / $1 out per million tokens: ~₹0.25 an answer).
  `reasoning.enabled=false` keeps Qwen from thinking first.
- Fallback: the local MLX Qwen (or `LLM_FALLBACK_*`) when the primary fails before writing
  anything — unreachable, 401/402/403/404/408/429, 5xx. Never mid-answer, so an answer is
  never stitched from two models. `src/rag/llm-targets.ts`; the `done` event carries `model`.
- Checked on 2 Oct: the key is valid; the paid model answers 402 until credits are bought;
  the `:free` Qwen 3.8-27B was rate-limited upstream, so free models are not a dependable
  primary.
- The model is a setting: the eval (`npm run eval:ask`) compares candidates.

## ADR-077 - Fixes from the 2 Oct baseline eval (2 Oct 2026)

Baseline (local Qwen3-8B, 43 cases): 72.1% pass, "not found" correct 25%, median chat 85 s.
Report `data/eval/runs/2026-10-02T18-03-28-287Z.json`. (ADR-076 is reserved for the planner.)

- Question reading: questions about content went to the order finder. Now Ask:
  "… का डिटेल / विवरण / बताने का कष्ट करें", "What support does …", a question opening
  with can/is/does/should … (but "Is there any order on …" still searches).
- A GO number's own date part ("61/2023/1100/12-5-2023/…") is no longer read as a date
  filter; dates are parsed from the question with the GO number removed.
- "Not found" in prose ("The provided evidence does not contain …", "… कोई जानकारी नहीं दी
  गई है") is treated as NO_ANSWER: the clean not-found reply, no citations
  (`isProseNonAnswer`: two or more sentences, a strict majority of them "not found").
- The not-found reply is not a dead end: it says what the archive holds (UP + Government of
  India) and what to try next. The last-resort fallback no longer talks about "safety
  checks"; it points to the page and the source card.
- Eval runner: the cached test profile is checked against the development profile list
  (the profile route needs a session, so each run made a new profile until the 5-profile
  limit refused them). Two expectations updated (medical probation is now scoped directly;
  the vague solar question accepts any PM-KUSUM order).

## ADR-078 - Authority order: rules and general orders lead the answer (3 Oct 2026)

Tiers (ADR-046) decided only what chat could see: confident C was left out, A and B were
equal. In the 2 Oct baseline, B orders pushed out the rule that answered the question.

- **Ranking:** chat retrieval sends `prefer_authority`; the retrieval service re-sorts the
  reranked pool by reranker score (as a logit) + an authority bonus: rulebook or tier A +1.0,
  B 0, low-confidence C −1.0, superseded −2.0 (`services/authority.py`; env
  `RAG_AUTHORITY_BONUS_A`, `RAG_AUTHORITY_PENALTY_C`, `RAG_SUPERSEDED_PENALTY`). Near-ties go
  to the rule; a clearly more relevant page still wins. `rerank_score_raw` is unchanged, so
  the relevance gate is unaffected. The Search tab keeps pure relevance order.
- **Prompt:** each evidence block carries `AUTHORITY=RULEBOOK | GENERAL | CONTEXT | SPECIFIC`;
  the model answers from RULEBOOK/GENERAL first, uses CONTEXT to add, and a SPECIFIC order
  only when asked about it or as one cited example. Source cards carry `authority`.
- **C stays search-only:** confident C never feeds an answer but the order finder lists it.
- **The unsorted middle:** 16,381 of 17,354 B orders are low-confidence "other" (KGMU
  superannuation, Agniveer reservation, PM-KUSUM, COVID office instructions among them).
  `classify:model` now uses the answer model's primary (OpenRouter), runs 6 at a time,
  takes `--tier B`, reports tokens, and is told B is not "unsure" and that amending
  orders are A.
- **Eval:** cases can set `expectGeneralSource` (18 rule questions do); the report shows
  "Answers citing a rulebook or general order" and each case's cited authorities.

## ADR-079 - Deleting profiles and accounts: soft delete first, then a real purge (3 Oct 2026)

Two levels, one rule: a delete takes effect at once for the person (gone from every list,
signed out), stays recoverable for a short window, and is then **really** deleted. A
mistaken tap on a phone must be recoverable; a deletion must not be kept forever.

**Profile delete (built now).**
- `workspace_users.deleted_at` + `purge_after` (migration 014). Deleting sets both
  (`purge_after` = +30 days) and revokes the profile's sessions. A deleted profile is left
  out of the switcher, cannot sign in, and does not count toward the 5-profile limit.
- "Recently deleted" on the switcher lists deleted profiles with the purge date and two
  actions: **Restore** (only when a slot is free; same limit lock as create) and
  **Delete now**.
- Purge = `DELETE FROM workspace_users`: departments, conversations, messages, state,
  sessions and feedback go with it (all `ON DELETE CASCADE`). Feedback is deleted, not
  anonymised: deletion means deletion. The API purges due profiles at start-up and whenever
  "Recently deleted" loads; `npm run workspace:purge` (also a `sync:daily` step) covers the rest.
- The last active profile cannot be deleted (409, and the switcher shows "Only profile"):
  with none left the switcher could not reach "Recently deleted", and removing everything
  is account deletion.
- Confirmation: one dialog naming the profile and its conversation count, a red
  "Delete profile" button. No typed name — the 30-day restore is the safety net.
- Until accounts exist these routes sit with the development sign-in
  (`/api/session/dev-users/...`) and are off in production. With accounts they move to
  `/api/account/profiles/...`, limited to the account's own profiles.

**Account delete (built with real sign-in, before the pilot).**
- `accounts.deleted_at` + `purge_after` (+7 days). Deleting signs the account out on every
  device and soft-deletes all its profiles with the same purge date.
- Signing in within 7 days shows "This account is scheduled for deletion on …" with
  **Cancel deletion**; that restores the account and the profiles it deleted (not ones
  deleted earlier on their own).
- Purge removes the account row, the phone number / identity link, and its profiles
  (cascade). Nothing about the person is kept; aggregate counters only.
- Required in-app by Apple and Google for any app with sign-up, so it ships with the
  mobile app at the latest. It also fits the DPDP Act 2023 right to erasure (to be checked
  by counsel before launch).

**What is outside the database.** Users add text only, so there are no user files in B2.
Application logs must not carry question text or contact numbers beyond their rotation
period; database backups keep deleted rows until the backup expires, which the privacy
notice must say (e.g. "removed from backups within 30 days").

## ADR-080 - First hosted eval run: notes, routing (3 Oct 2026)

OpenRouter `qwen/qwen3.6-35b-a3b`: median chat 21 s (was 85 s on local Qwen3-8B), no
repairs, no fallbacks. The run stopped at case 19 when the API went away ("terminated",
then "fetch failed" for the rest), so only 18 cases count.

- The hosted model ended answers with "(Note: numbers are masked … verify against the
  original source)" — internal plumbing. The prompt no longer asks it to label risky
  numbers in prose, and `stripVerificationNotes` drops such trailing note paragraphs
  (never the last citation). The eval no longer calls an answer cut off when it ends in
  closing markdown.
- "… को क्या प्रोत्साहन …", "… के संबंध में क्या आदेश है?", "What incentives …" went to
  the order list. Ask now takes a Hindi "क्या …" question unless it asks for new orders
  ("क्या कोई नया …", "… के शासनादेश क्या हैं?"), and English "what incentives / benefits /
  support …".
- Full hosted run (3 Oct, 16:30): 88.4% pass, "not found" 100%, median chat 18 s, search
  12.6 s. Two failures were test wording (सौर पंप; the generic Project Alankar question now
  accepts any Alankar order). A not-found now records whether the model said
  NO_ANSWER or the prose detector fired (`noEvidenceReason`, plus a server log line with
  the draft start and the pages), to trace the toy-policy "not found". The eval's
  "rulebook or general order" rate now counts only the rule questions.

## ADR-081 - Routine orders can still answer; blank pages get OCR first (3 Oct 2026)

Evening eval after the model classification went live (86.0%): the Project Alankar
boundary-wall order and the KGMU retirement-age order were relabelled C (a sanction;
one university), so chat could not see them and said "not found".

- **Routine orders take part in chat with a penalty** instead of being left out:
  confident C −1.5, unsure C −1.0 (logit), against +1.0 for rulebooks and tier A
  (`services/authority.py`). A question clearly about one routine order is answered from
  it; on a near-tie the rule wins, and the prompt still treats SPECIFIC sources as
  examples only. Most confident-C orders are not indexed at all (heavy steps skip them),
  so this adds few pages. `RAG_CHAT_INCLUDE_ROUTINE=0` restores the old exclusion.
- **Describing sources is not answering:** "स्रोत S1 में केवल …", "Sources S2 and S5 …"
  count as non-answer sentences (metro fare answered with three cited "not about this").
- **Blank pages:** the toy-policy order has text on page 1 only; pages 2–20 are scans
  never OCR'd, because OCR is decided per document (≥ 100 bytes of native text = no
  OCR). 249 indexed orders (172 tier A) have 2,532 such pages. `compare:suspicious`
  already treats a blank page as a candidate; it now takes up to 10,000 pages per run and
  does tier A, then B, first.
- **Coverage:** of 11,196 tier-A orders only 3,045 are indexed for answers: 1,896 are
  downloaded but not yet built (the next `sync:daily` does it) and 5,887 are not
  downloaded yet (portal capture).
- Maternity leave: answered "the two-year gap still applies" from the Handbook page; the
  2 Sept 2026 order that removed it has garbled native text and no link to Rule 153(1).
  Next: links from orders to the rulebook rules they amend.

## ADR-082 - Officers' words vs. the rulebook's words; no dead-end follow-ups (3 Oct 2026)

"What are the service bid experience clause in GFR" got four cited bullets on what the
pages do not say, then the raw `NO_ANSWER_IN_EVIDENCE`; the clicked suggestion then said
"type the question yourself". The rule is in the archive (Manual for Procurement of
Non-Consultancy Services 2025, pp. 106–109: experience of similar services — 3 × 40%,
2 × 50% or 1 × 80% of the estimated cost), but none of its pages was retrieved: the
officer's words ("experience clause", "GFR") are not the manual's words.

- **Search wording:** before retrieval, one short call to the hosted answer model rewrites
  the question as two search queries in official wording (English + Hindi,
  `src/rag/query-expansion.ts`). The retrieval service searches the question and both
  rewrites and merges the candidates; pages are still reranked against the question
  itself, so the relevance gate and citations are unchanged. Not used for cited-order
  follow-ups or an explicit order, nor with a local model. ~1.5–4 s; shown as "Search
  wording" in the latency panel. `RAG_QUERY_EXPANSION=0` turns it off.
- **The token is never shown:** NO_ANSWER_IN_EVIDENCE after prose that opens with "the
  evidence does not contain …" is a "not found"; a stray token after a real answer is
  removed (`withoutNoAnswerToken`).
- **No dead-end follow-ups:** when a suggested question is not answered by the cited
  orders, the web app asks it again as a new question over all orders instead of telling
  the officer to retype it (nothing is saved for the first attempt). No suggestions are
  offered after a "not found".

## ADR-083 - General-knowledge answers instead of "not found", clearly labelled (3 Oct 2026)

Abhishek: "if 2–3 searches do not give results nobody will use it further". Ask answered
only from retrieved pages, so every retrieval miss became "not found", while ChatGPT
answers from what the model knows. Decision (Abhishek): when no archived page answers,
answer from general knowledge, clearly labelled (Rulebook §4).

- Triggered where "not found" was sent: no relevant page, the model's NO_ANSWER, or a
  prose non-answer (first draft or after repair). Not for cited-order follow-ups (the web
  app re-asks those over all orders) or an explicitly named order; not with a local model.
- Prompt (`src/rag/general-knowledge.ts`): answer first, ≤ 6 bullets, name the rule /
  manual / act behind each point, no invented GO numbers, dates or figures ("check the
  current order" where they may have changed), say so when unknown. The titles of the
  closest retrieved documents are given as hints and listed under the answer.
- `done.generalKnowledge = true`, `validated = false`; the web app shows the note above the
  answer and a "General knowledge" badge, and offers no suggestions.
- Eval: for not-found cases a labelled general-knowledge answer counts as correct; for
  answerable cases it is a miss ("answered from general knowledge although the archive
  has the order"), so retrieval gaps stay visible.
