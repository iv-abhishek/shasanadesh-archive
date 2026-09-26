# Snapshot (generated)

Generated 26 Sept 2026, 7:25 pm (Asia/Kolkata) by `npm run handoff:snapshot`. Do not edit by hand.

## Git

- Branch: `main`
- HEAD: `a965553 feat(search): organise results by department; ID-based department matching; handoff files`
- Unpushed commits: 0

Uncommitted files:

```
M README.md
A  apps/web/app/api/rag/documents/[action]/route.ts
M  apps/web/app/globals.css
A  apps/web/components/browse-orders.tsx
M  apps/web/components/search-app.tsx
M  docs/DECISIONS.md
M  docs/FRONTEND.md
M  handoff/LOG.md
M  handoff/PLAN.md
 M handoff/SNAPSHOT.md
M  handoff/STATUS.md
MM package.json
M  src/api/server.ts
A  src/documents/browse.test.ts
A  src/documents/browse.ts
A  src/documents/routes.ts
?? scripts/shasanadesh-portal-bridge.mjs
?? src/ingest-portal.ts
```

Recent commits:

```
a965553 feat(search): organise results by department; ID-based department matching; handoff files
1b139de Shasanadesh ingestion
68e944e feat: IST display time zone, legacy-font garble detection, Hindi fallback
7c9926b feat(web): question timestamps and answer actions (copy, listen, feedback, regenerate)
253af98 feat(api): answer feedback, in-place regenerate, feedback report
b51e84a fix(web): EN/HI toggle no longer turns green on hover
6d5d23a feat(web): pin the chat composer to the bottom; configurable rerank count
7f4b785 feat(workspace): officers may hold zero, one or several departments with additional charge
47bb2f9 feat(web): live progress, formatted answers, sources grouped by order
7a9eb61 feat(api): stream progress events; faster reranking and smaller prompts
093f523 fix(web): clear service errors with Retry; stop saving failed questions
5f69739 feat: npm run dev:all starts the whole local stack
00ff2a8 fix: load .env for the Python embedding, retrieval and search commands
4036e07 docs: record 2026-09-26 maintenance state and follow-up commands
1f676ef perf(retrieval): widen HNSW scan and reuse one connection; pin dependencies
```

## Corpus by source

| Provider | Documents | In B2 | Pages | Selective-OCR pages |
|---|---:|---:|---:|---:|
| doe-gfr | 1 | 1 | 7 | 0 |
| shasanadesh-up | 678 | 677 | 125 | 47 |

- Retrieval variant chunks: 336
- B2 configured: yes
- Submission queue entries: 0
- Shasanadesh crawl: not started

## Shasanadesh portal capture

- Listing: 1025 unique orders from 11 result pages
- In B2: 653 · not yet stored: 372 · retrying: 0 · unavailable (404/410): 0
- Listing complete: no
