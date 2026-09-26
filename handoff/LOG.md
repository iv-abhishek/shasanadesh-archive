# Log

Newest first. One entry per working session or milestone. Append, don't rewrite.

## 26 Sept 2026, 10:35 pm IST (Claude)

- Abhishek tested Ask after the pipeline run: the Hindi solar-pump guideline answer was right
  (with Hindi "संदर्भ कॉपी करें"); "medical officer seniority … probation" failed because the
  profile's departments were a hard filter, weak pages were used, and the "not found" answer
  was forced to cite. Added the relevance gate, scope fallback, NO_ANSWER_IN_EVIDENCE, cited-only
  sources, and a deduplicated department picker (ADR-047). Tests + browser checks pass.

## 26 Sept 2026, 8:55 pm IST (Claude)

- Abhishek ran push, db:migrate (007 applied), classify:orders (A 25 / B 48 / C 977), db:load
  (679 documents classified). build:pages now also skips confident tier C; the console's
  "Text indexed" now means the order has searchable chunks.

## 26 Sept 2026, 8:45 pm IST (Claude)

- Built the order classifier (rules on listing subject/category; 20 hand-labelled tests),
  `npm run classify:orders`, overrides file, migration 007, db:load step, processing gate for
  OCR/chunking, chat exclusion of confident tier C (+ pgvector iterative scan), console tier
  filter and badges, and "Copy reference" / "Official copy" on answer source cards.
  Tested: unit tests, embedded Postgres against the 679 real orders (59 visible to Ask),
  browser checks. ADR-046.

## 26 Sept 2026, 8:10 pm IST (Claude)

- Abhishek confirmed: GOs are public; users are all-department staff (IAS, officials, DEOs,
  consultants) citing common orders in letters; narrow orders stay on the portal; NIC
  request at launch; hosting left to Claude → recommended a model API for the pilot
  (~$100–200/month) and an India GPU later (ROADMAP §9).

## 26 Sept 2026, 8:00 pm IST (Claude)

- Product direction from Abhishek: Ask only for end users; Search is internal; focus on
  central + UP guidelines; routine GOs not useful; daily ingestion after backfill; cite
  official links. Wrote docs/ROADMAP.md. Measured: ~57% of 654 portal captures are
  financial sanctions/budget; only 6 are tagged as guidelines by the portal.

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
