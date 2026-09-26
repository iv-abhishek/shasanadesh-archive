# Status

_Last updated: 26 Sept 2026, 8:00 pm IST (Claude). Update at every milestone and at least every 2–3 hours of active work._

## Current focus (set by Abhishek, 26 Sept 7:06 pm)

1. **Search page review and improvements**: organised by department. **Done**, see below.
2. **Model question**: can Qwen3.8-27B run usefully on the M5 MacBook Air? Answered (see PLAN.md › Models).
3. **Ingestion is ON HOLD.** Do not start `ingest:portal`, `portal:bridge`,
   `ingest:source*` or any crawl until Abhishek says so.

## Roadmap

Drafted in `docs/ROADMAP.md` (Phase 0–5). **Waiting on Abhishek** for the 5 open decisions in
§7 (launch audience, central-first vs UP-first, hosting budget, tier B/C in Ask, NIC request).

## What works

- Local stack: `npm run dev:all` (Postgres, retrieval :8788, MLX generator :8791, API :8787, web :3000).
- Chat: live progress, validated answers with page citations, Hindi fallback, a
  "why the safety check stepped in" panel, copy/listen/feedback/regenerate, and IST timestamps.
- Search › **Browse all orders** (default tab): every order matching the filters, like the
  portal: department → section → category, GO number, subject words, dates, my departments;
  total count and pages. Needs `npm run db:load` to show the portal captures.
- Search › Search inside orders: results grouped by department (English and Hindi names of one Shasanadesh
  department are merged by department ID), department chips, "Search only here",
  close vs. less-relevant split, readable snippets, portal dates and subjects.
- Department filters (chat scope and Search) match by Shasanadesh department ID
  as well as by name (ADR-044).
- Source adapters exist and are separated by collection: `shasanadesh-up`,
  `doe-gfr`, `upgov`, `invest-up`, `uppolice` (B2 `archive/<collection>/…`,
  `documents.provider`). The listing metadata is kept verbatim.

## Ingestion state (paused)

- Portal capture through `portal:bridge`: result pages 1–11 → **1,025 unique orders listed**.
  The portal reports about 177,504.
- `ingest:portal`: **653 stored in B2**, 0 failures, **372 not yet fetched**. The last
  activity was 26 Sept, 6:50 pm IST. Rerunning `npm run ingest:portal` resumes from the checkpoint.
- The listed portal orders are **not yet loaded into Postgres or embedded**, so they are not
  searchable yet.
- `scripts/shasanadesh-portal-bridge.mjs` and `src/ingest-portal.ts` (with the README
  and package.json lines for them) are **uncommitted**. Review them and commit when ingestion resumes.

## Open problems

- Garbled legacy-font Hindi (e.g. 61#37#5#2023) still needs the OCR rerun (commands below).
- The portal result order is not stable: pages 1–11 held 1,100 rows but only
  1,025 unique orders, so roughly as many were probably skipped. See PLAN.md › Ingestion.
- The profile department picker lists both spellings (English and Hindi) once portal
  orders are loaded. It needs a bilingual department registry (PLAN.md › Search).
- Local disk: the importer keeps every original under `data/documents/`
  (~0.5 MB/PDF, ~1.4 MB/order with derived files), which is ~250 GB for the full portal.

## Next commands (Abhishek, on the Mac)

```
git push
npm run db:load                           # makes the 653 portal orders appear in Browse
npm run compare:suspicious -- --max 100   # repeat until no "Remaining" line
npm run build:retrieval-variants
npm run build:retrieval-variant-chunks
npm run db:load
npm run embed:chunks
npm run dev:all
```

## Next work (Claude)

- Bilingual department registry (department ID → English + Hindi name) and a deduplicated profile picker.
- When ingestion resumes: a per-department capture plan and completeness reconciliation,
  batch db:load + embed for portal captures, and a local-disk policy.
