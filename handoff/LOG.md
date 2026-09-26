# Log

Newest first. One entry per working session or milestone. Append, don't rewrite.

## 26 Sept 2026, 7:45 pm IST (Claude)

- Search page: new default tab "Browse all orders", a portal-style listing of every
  order matching department/section/category/GO number/subject words/dates, with totals
  and pages (`src/documents/`, `/api/documents/browse|facets`, ADR-045). Tested
  against the real 679 local order records (embedded Postgres) and in the browser at desktop and phone widths.

## 26 Sept 2026, 7:20 pm IST (Claude)

- Search page: grouped by department (merged by Shasanadesh department ID),
  department chips, "Search only here", readable-page snippets, subject titles,
  portal dates; up to 24 pages per search.
- Retrieval filters: department name matches are widened by department ID and
  ignore zero-width joiners (ADR-044). db:load parses portal `DD/MM/YYYY` dates.
- Handoff: added STATUS.md, PLAN.md and this LOG; the snapshot now reports
  portal-capture progress.
- Ingestion paused on Abhishek's instruction (1,025 listed, 653 in B2, 372 pending).
- Answered the Qwen3.8-27B question (PLAN.md › Models).

## 26 Sept 2026, 4:54 pm IST (Abhishek, commit 1b139de)

- Added the upgov / invest-up / uppolice adapters, the handoff README and
  snapshot, and a Search page rewrite. Portal bridge and importer used for the
  first capture (uncommitted).

## 26 Sept 2026, morning (Claude)

- IST display time zone from env, legacy-font garble detection, Hindi fallback,
  validation-issue panel (68e944e). Earlier: answer actions, feedback,
  regenerate, department charges, composer dock, progress events, B2 checks.
