# Status

_Last updated: 26 Sept 2026, 10:50 pm IST (Claude). Update at every milestone and at least every 2–3 hours of active work._

## Current focus (set by Abhishek, 26 Sept 7:06 pm)

1. **Search page review and improvements**: organised by department. **Done**, see below.
2. **Model question**: can Qwen3.8-27B run usefully on the M5 MacBook Air? Answered (see PLAN.md › Models).
3. **Ingestion is ON HOLD.** Do not start `ingest:portal`, `portal:bridge`,
   `ingest:source*` or any crawl until Abhishek says so.

## Roadmap

`docs/ROADMAP.md` (Phase 0–5), decisions **confirmed** 26 Sept (§7): all-department staff
audience (public allowed); UP core first, then central; narrow orders excluded from Ask;
NIC request at launch; hosting = model API for the pilot, India GPU later (§9).
Current phase: **Phase 0**, with Phase 1 started (classification rules pass done).

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
- **Order classification (ADR-046):** `npm run classify:orders` gives every listed/captured
  order a type and tier (A generally applicable / B context / C routine). On 1,025 listings:
  A 25, B 48, C 977 (58 low confidence). `db:load` stores it (migration 007); chat leaves out
  confident tier C; OCR/chunking skip it; the console has a tier filter ("A + B · what Ask uses").
- **Copy reference** on answer source cards ("शासनादेश संख्या …, दिनांक DD.MM.YYYY") plus an
  **Official copy ↗** link to the issuing site.
- **Relevance gate (ADR-047):** weak pages are dropped (`RAG_MIN_RELEVANCE`, default 0.1,
  uncalibrated); nothing relevant in the profile's departments → all departments searched
  ("Searched all departments"); still nothing → fixed "no matching order" answer without
  sources. Only cited orders are shown under an answer; others behind a toggle. The
  latency panel shows "Best match" for calibration.
- Answers never end mid-word (ADR-048): Hindi token budget 1800, repair gets the full
  budget, length-stopped answers are trimmed to the last full sentence and badged "Shortened".
- Department picker: one choice per department (English name preferred).
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

- Calibrate `RAG_MIN_RELEVANCE`: note "Best match" for good vs. unrelated questions (26 Sept
  tests: solar-pump question answered well; "medical officer seniority" with a profile
  lacking Medical and Health returned unrelated Agriculture pages → fixed by ADR-047).

- Garbled legacy-font Hindi (e.g. 61#37#5#2023) still needs the OCR rerun (commands below).
- The portal result order is not stable: pages 1–11 held 1,100 rows but only
  1,025 unique orders, so roughly as many were probably skipped. See PLAN.md › Ingestion.
- The profile department picker lists both spellings (English and Hindi) once portal
  orders are loaded. It needs a bilingual department registry (PLAN.md › Search).
- Local disk: the importer keeps every original under `data/documents/`
  (~0.5 MB/PDF, ~1.4 MB/order with derived files), which is ~250 GB for the full portal.

## Next commands (Abhishek, on the Mac)

Done 26 Sept, 8:14 pm: push, db:migrate (007), classify:orders, db:load (679 orders, all classified).

Make the useful portal orders searchable (tier C is skipped automatically):

```
git push
npm run ocr:needs                          # OCR only for scanned PDFs without a text layer
npm run build:pages                        # page text for tier A/B + unclassified orders
npm run compare:suspicious -- --max 100    # fix garbled pages; repeat until no "Remaining"
npm run build:retrieval-variants
npm run build:retrieval-variant-chunks
npm run db:load
npm run embed:chunks
npm run dev:all
```

## Next work (Claude)

- Classification pass 2: local-model pass over low-confidence orders (subject + first page),
  then a review action in the console that writes `datasets/classification-overrides.jsonl`.
- Phase 0 eval set: 100–150 real questions with the correct page (needs the indexed corpus).
- Bilingual department registry (department ID → English + Hindi name) and a deduplicated profile picker.
- When ingestion resumes: a per-department capture plan and completeness reconciliation,
  batch db:load + embed for portal captures, and a local-disk policy.
