# Frontend

The first frontend is a small Next.js client in `apps/web`.

Its job is to exercise the frozen RAG API contract before visual/product polish.

## Current capabilities

- English/Hindi question input
- SSE `sources`, `token`, `done`, and `error` handling
- live progress while an answer is prepared (searching, reading, writing,
  re-checking) with elapsed seconds
- validated answer display with bullet / numbered lists, headings and bold
- a timestamp on every question
- answer actions: Copy (answer plus cited sources), Listen (browser speech,
  Hindi or English voice by script), thumbs up / down with an optional reason
  and comment, and Regenerate for the latest answer
- sources grouped into one card per order, with page chips: cited pages
  first, other matches next, neighbouring pages collapsed behind "+N nearby"
- clickable `[S# p.#]` citations
- source cards linking to exact PDF pages
- OCR/numeric verification badges
- repair / qualitative-salvage / fallback indicators
- visible local response latency
- development profile onboarding with name, designation, language, and search scope
- editable profile with state/UT, district, optional contact number, language, and search scope
- primary and additional department selection using touch-friendly checkboxes
- persistent conversation list and saved message/source history
- pinned conversations grouped above recent history
- permanent conversation deletion with a confirmation step; deleting a conversation also deletes its saved messages and state

This is a working MVP. Workspace profiles remain development identities; public/official
profile types and production identity verification are not implemented. Contact numbers
are optional profile details and are not used to authenticate a user.

## Local run

Keep the backend services running:

- PostgreSQL
- retrieval service on `8788`
- MLX generator on `8791`
- TypeScript API on `8787`

Install frontend dependencies once:

```bash
npm --prefix apps/web install
```

Copy the local environment template:

```bash
cp apps/web/.env.local.example apps/web/.env.local
```

Start the frontend together with every backend service:

```bash
npm run dev:all
```

or only the frontend with `npm run web:dev`.

When a service is down, the chat names it (API :8787, retrieval :8788,
generator :8791 or PostgreSQL) and offers Retry. Failed questions are not
saved; a conversation is written to history only after an answer completes.

Then open:

`http://127.0.0.1:3000`

## Safety UI

`conflict`, `ocr_only_unverified`, and `unverified` evidence is surfaced with a warning
badge. The frontend does not reinterpret reranker scores as factual confidence.

Critical numeric claims remain subject to the backend safety gate and original-page
verification policy.

## Next frontend increments

1. Add an in-app evidence view with exact-page document navigation and visible issuer,
   date, document type, and amendment/supersession links.
2. Add focused department, date, and document-type filters.
3. Design separate general/public and verified-official onboarding after the backend
   identity and profile model is ready.
4. Polish responsive layouts and accessible states.

Profile edits and conversation reads/updates require the active HttpOnly workspace
session and match the route profile ID against that session. Conversation pins are
stored in PostgreSQL. Deletion removes the conversation row and its dependent
messages/state.
Migration `004_workspace_preferences.sql` adds the new profile fields and pin column,
`005_department_charges.sql` adds additional-charge flags, and
`006_message_feedback.sql` adds answer feedback; run
`npm run db:migrate` before running the updated API.

The chat composer is pinned to the bottom of the window. Asking a question
scrolls it to the top of the view so its progress and answer appear directly
below; the header compacts once a conversation has turns.

Conversation history and source cards are already implemented; production identity and
authorization remain backend prerequisites for real official profiles.

## Same-origin RAG proxy

The browser does not call port `8787` directly. It posts to the Next.js same-origin route:

`/api/rag/chat`

That route streams the backend response from:

`http://127.0.0.1:8787/api/chat`

This removes browser CORS/origin coupling while preserving the backend SSE contract.
`RAG_API_BASE_URL` is server-side configuration and is not exposed as a
`NEXT_PUBLIC_*` variable.


## Search page

Search asks the retrieval service for up to 24 pages (the reranked pool) and
organises them:

- **by department** — sections in relevance order (a department is placed by
  its best order), with department chips above the results to show one
  department at a time, and "Search only here" to rerun the query filtered to
  that department. Shasanadesh orders are grouped by the department ID in their
  source ID, so English and Hindi spellings of one department share a section
  (ADR-044);
- **then by order** — one card per order with its subject/title, GO number,
  date and archive, the matching pages as chips, and a snippet from the
  best-ranked page whose text layer is readable (legacy-font pages are skipped;
  if every matched page is garbled a note says to open the page);
- **close vs. less relevant** — orders far below the best reranker score are
  collapsed under "less relevant orders".

## Dates and times

All date/time display goes through `apps/web/lib/app-time.ts`, which formats in
`NEXT_PUBLIC_APP_TIME_ZONE` (default `Asia/Kolkata`) instead of the browser's or
host's zone. Do not call `toLocaleString()` without it.

## Retrieval provenance and latency diagnostics

Chat source cards distinguish direct retrieval hits from adjacent context pages. Answer
cards expose a collapsed latency breakdown during development so slow retrieval,
reranking, generation, and repair paths can be identified without guessing.

When the first draft fails the safety gate, a "Why the safety check stepped in"
panel lists the validation issues in plain words (first draft and after
repair) and whether repair, salvage or the fallback produced the final answer.
The conservative fallback is written in Hindi for Hindi questions.
