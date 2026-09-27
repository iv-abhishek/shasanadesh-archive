# Log

Newest first. One entry per working session or milestone. Append, don't rewrite.

## 27 Sept 2026, 8:00 pm IST (Claude)

- Start page and search guide (ADR-060): three task cards with examples, the search
  guide (phrases, wildcards, numbers, sections, dates, departments), "?" guide button by
  the input. Checked light/dark at 1280 px and 390 px.

## 27 Sept 2026, 7:30 pm IST (Claude)

- Stop button (ADR-059): Stop/Esc cancels the request end to end (browser → proxy → API →
  retrieval/model); the question returns to the box for editing. Wildcard stems now join
  meaning-based subject matching.

## 27 Sept 2026, 7:00 pm IST (Claude)

- Find orders from Ask (ADR-058): number, phrase, wildcard, section/issuer, department,
  dates, words; meaning-based subject matching (`embed:subjects`, migration 009,
  retrieval `/subjects/search`). Word/number/section/wildcard paths checked on the 679
  real orders in a temporary Postgres; the meaning search needs the Mac (model) to test.
  3 eval cases (`order-find`).

## 27 Sept 2026, 5:45 pm IST (Claude)

- Order lists (ADR-057) after Abhishek's screenshot ("recent … basic education" gave an
  Agriculture fallback): list intent with English/Hindi dates, department registry
  (59 departments), `department_ids` retrieval filter, "Order list" badge, no "Validated"
  on safe fallbacks, 2 eval cases. Checked on the 679 real orders in a temporary Postgres.
  Restart `npm run dev:all` (API + retrieval) to pick it up.

## 27 Sept 2026, 5:00 pm IST (Claude)

- Local disk policy (ADR-056): `storage:report|trim|restore`, OCR page images deleted after
  reading, free-space floor in both importers (`MIN_FREE_DISK_GB`, default 40), restore +
  trim in the daily sync. Measured: tier C 660 KB/order → ~21 KB after trim; projection for
  177,504 orders ≈ 15 GB. Trim/restore tested on copies (restore with a simulated B2).

## 27 Sept 2026, 4:05 pm IST (Claude)

- Links between orders (ADR-054): `relations:build`, migration 008 `document_relations`,
  db:load, "LATER_CHANGES" in the prompt (digit-free), "⚠ Amended by GO …" on source cards.
  Tests: `npm run test:relations`, `test:go-reference`; SQL checked on embedded Postgres.
- To use it: `npm run db:migrate && npm run relations:build && npm run db:load`.
- Daily sync (ADR-055): `scripts/daily-sync.mjs` + `scripts/install-daily-sync.sh`
  (launchd). Tested on a stub project: step order, non-critical vs stopping failures,
  lock, report. Not scheduled; fetching stays off by default.

## 27 Sept 2026, 4:50 pm IST (Claude)

- Classification pass 2: `npm run classify:model` (generator verdicts for low-confidence
  orders; human > model > rules) and console A/B/C buttons with immediate DB update +
  overrides file (ADR-053). Endpoint tested on embedded Postgres; buttons in the browser.

## 27 Sept 2026, 4:30 pm IST (Claude)

- Draft preview while answering + hosted-model switch (ADR-051, d060925).
- Committed Abhishek's bridge/importer as used (d2f4e5e), then: per-department listings,
  capture bookmark (tested on a mock portal page in Chromium), reshuffle handling, CORS/PNA,
  `portal:report`, importer `--until-idle` / routine-PDF eviction / `--evict-existing`,
  viewer fallback to the official link (ADR-052). Bridge tested end to end on a copy of the
  real capture data.

## 26 Sept 2026, 11:15 pm IST (Claude)

- Regression set: runner extended (profile-scope cases, expected "not found", cut-off /
  text-less answer checks, relevance calibration); 24 verified cases; `npm run eval:ask`.
- Found that ~190/196 indexed native pages have broken conjuncts (e.g. "सूित"); added the
  leading-vowel-sign signal to the quality score so compare:suspicious OCRs them (ADR-050).

## 26 Sept 2026, 10:55 pm IST (Claude)

- Retest of "Project Alankar" returned five bare "[S1 p.1]" bullets (qualitative salvage).
  Cause: claim splitter separated "…है। [S1 p.1]". Fixed + tests (ADR-049).

## 26 Sept 2026, 10:50 pm IST (Claude)

- "Project Alankar" Hindi answer was correct but cut mid-word (repair capped at 450 tokens).
  Added per-language budgets, full-budget repair, trim-to-last-sentence on finish_reason=length,
  "Shortened" badge, concise-answer prompt rule (ADR-048).

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
