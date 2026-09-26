# Frontend

The first frontend is a small Next.js client in `apps/web`.

Its job is to exercise the frozen RAG API contract before visual/product polish.

## Current capabilities

- English/Hindi question input
- SSE `sources`, `token`, `done`, and `error` handling
- validated answer display
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

Start the frontend:

```bash
npm run web:dev
```

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
Migration `004_workspace_preferences.sql` adds the new profile fields and pin column;
apply pending database migrations before running the updated API.

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


## Retrieval provenance and latency diagnostics

Chat source cards distinguish direct retrieval hits from adjacent context pages. Answer
cards expose a collapsed latency breakdown during development so slow retrieval,
reranking, generation, and repair paths can be identified without guessing.
