# Status

_Last updated: 27 Sept 2026, 4:05 pm IST (Claude). Update at every milestone and at least every 2–3 hours of active work._

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
- Citation-after-full-stop fix (ADR-049): no more citation-only bullets from salvage.
- Answers never end mid-word (ADR-048): Hindi token budget 1800, repair gets the full
  budget, length-stopped answers are trimmed to the last full sentence and badged "Shortened".
- **Later changes (ADR-054):** `npm run relations:build` finds "amended / superseded /
  cancelled / corrected by" links between orders (subject + native text; key = serial +
  year, plus date). `db:load` stores them (migration 008). Answers say when a cited order
  was later changed, and the source card shows "⚠ Amended by GO … dated …" with the
  official link. Local corpus: 46 references, 2 matched (grows with ingestion).
- **Daily sync (ADR-055):** `npm run sync:daily` (processing only unless `-- --ingest`),
  report in `data/sync/reports/`; `npm run sync:schedule` installs a nightly launchd job
  (not installed yet; Abhishek decides when).
- **Order lists (ADR-057):** "recent orders of basic education", "21.09.2026 के शासनादेश",
  "orders issued this week" are answered from the order list, newest first (no model).
  Departments named in English or Hindi resolve through `datasets/departments.json`
  (English names marked `translation` should be reviewed).
- **Find orders from Ask (ADR-058):** GO number ("51/2026"), "quoted phrase", wildcards
  (`solar*`, `*मेट्रो*`), issuing section ("released by लोक निर्माण अनुभाग-1"), department,
  dates and subject words, in English or Hindi; English words find Hindi subjects once
  `npm run embed:subjects` has run (migration 009).
- **Core rules collection (ADR-062):** 15 reviewed documents (GFR, DFPR, procurement
  manuals, GeM GTC + UP GeM GOs, Make in India order, UP Budget Manual, Conduct Rules) in
  `datasets/core-rules/catalogue.json`; always tier A and never filtered out by department.
  **Not ingested yet:** `npm run ingest:source -- core-rules`, then the processing steps.
- Department picker: one choice per department (English name preferred).
- Department filters (chat scope and Search) match by Shasanadesh department ID
  as well as by name (ADR-044).
- Source adapters exist and are separated by collection: `shasanadesh-up`,
  `doe-gfr`, `upgov`, `invest-up`, `uppolice` (B2 `archive/<collection>/…`,
  `documents.provider`). The listing metadata is kept verbatim.

## Ingestion state (paused, tooling ready)

- Tooling for the full portal is ready (ADR-052): per-department capture with the bridge
  bookmark, `portal:report` reconciliation, `ingest:portal -- --until-idle`, routine
  originals kept only in B2. The bookmark was tested on a mock results page; **try it on
  one real portal page first** and share the bridge message if a column or the page
  number/total is not recognised.

- Portal capture through `portal:bridge`: result pages 1–11 → **1,025 unique orders listed**.
  The portal reports about 177,504.
- `ingest:portal`: **653 stored in B2**, 0 failures, **372 not yet fetched**. The last
  activity was 26 Sept, 6:50 pm IST. Rerunning `npm run ingest:portal` resumes from the checkpoint.
- The captured orders are loaded into Postgres (db:load, 679 classified, 27 Sept) and
  browsable; only tier A/B orders with pages and embeddings reach Ask (59 of 679).
- `scripts/shasanadesh-portal-bridge.mjs` and `src/ingest-portal.ts` are committed (ADR-052).

## Open problems

- Calibrate `RAG_MIN_RELEVANCE`: note "Best match" for good vs. unrelated questions (26 Sept
  tests: solar-pump question answered well; "medical officer seniority" with a profile
  lacking Medical and Health returned unrelated Agriculture pages → fixed by ADR-047).

- Garbled legacy-font Hindi (e.g. 61#37#5#2023) still needs the OCR rerun (commands below).
- The portal result order is not stable: pages 1–11 held 1,100 rows but only
  1,025 unique orders, so roughly as many were probably skipped. See PLAN.md › Ingestion.
- The profile department picker lists both spellings (English and Hindi) once portal
  orders are loaded. It needs a bilingual department registry (PLAN.md › Search).
- Local disk: solved by ADR-056 (B2 is the archive, the Mac a cache). Projection for the
  full portal ≈ 15 GB of order files + a few GB of Postgres. Run `npm run storage:trim --
  --apply` once to free the ~470 MB already reclaimable.

## Next commands (Abhishek, on the Mac)

OCR the broken-conjunct pages (ADR-050; ~190 pages, roughly 20–30 min), rebuild, then
run the regression set (~30–45 min):

```
git push
npm run db:migrate                         # adds document_relations (008), subject vectors (009)
npm run embed:subjects                     # one vector per order subject (a few minutes)
npm run relations:build
npm run compare:suspicious -- --max 300    # repeat until no "Remaining" line
npm run build:retrieval-variants
npm run build:retrieval-variant-chunks
npm run db:load
npm run embed:chunks
npm run dev:all                            # keep running; in a second terminal:
npm run eval:ask
```

Share the summary block and the "Failures" section of `data/eval/runs/<latest>.md`.

## Next work (Claude)

- Done 26–27 Sept: classification pass 2 + console review (ADR-053), draft streaming and
  hosted-model settings (ADR-051), per-department capture (ADR-052), order links (ADR-054),
  daily sync (ADR-055).
- Eval set: 24 verified cases in eval/rag-cases.json; grow toward 50–100 from real
  questions and thumbs-down feedback once the baseline run is in.
- Department registry exists (ADR-057); next: use it for labels in the picker and Search.
- Order links, next: rank the current version above the one it replaced; "orders this one
  relies on" (the `refers` links).
