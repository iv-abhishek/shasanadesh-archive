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

After this shell is validated:

1. exact-page PDF viewer inside the app;
2. search/filter mode beside chat;
3. conversation persistence;
4. department/date/order filters;
5. mobile polish;
6. production authentication and deployment.

## Same-origin RAG proxy

The browser does not call port `8787` directly. It posts to the Next.js same-origin route:

`/api/rag/chat`

That route streams the backend response from:

`http://127.0.0.1:8787/api/chat`

This removes browser CORS/origin coupling while preserving the backend SSE contract.
`RAG_API_BASE_URL` is server-side configuration and is not exposed as a
`NEXT_PUBLIC_*` variable.
