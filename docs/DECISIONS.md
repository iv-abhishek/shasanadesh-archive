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
