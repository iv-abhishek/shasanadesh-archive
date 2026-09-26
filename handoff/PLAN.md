# Plan

The roadmap and the current route for each workstream. When a route changes,
edit it here and say why (with the date) under "Route changes".

## 1. Answer quality

- Route: fix data before models. Garbled native text → selective OCR (ADR-043),
  numeric verification gate (ADR-042), Hindi fallback.
- Next: finish the OCR rerun, then run `npm run eval:rag` and add the solar-pump
  question and thumbs-down cases (`npm run feedback:report`) to `eval/rag-cases.json`.

## 2. Search

- Done (26 Sept): grouped by department → order, department chips,
  "Search only here", readable snippets, portal subject/date, ID-based
  department matching (ADR-044).
- Done (26 Sept, evening): "Browse all orders" tab, a portal-style complete listing with
  filters, counts and pagination (ADR-045).
- Next: a bilingual department registry (table keyed by Shasanadesh department
  ID with English and Hindi names), used by the profile picker, chat scope and
  Search labels; then department and date facets computed server-side over all
  matches, not just the top 24 pages.

## 3. Ingestion (ON HOLD, restart only when Abhishek says)

- Sources are kept separate by collection (`archive/<collection>/` in B2,
  `documents.provider` in Postgres, source-ID prefix), and each listing's
  metadata is kept verbatim (`sourceRecord` / `portal` block).
- Shasanadesh portal: a person completes the search CAPTCHA in the browser;
  `portal:bridge` receives result pages; `ingest:portal` downloads the PDFs at
  ≥3 s per request and stores them in B2. No CAPTCHA solving or bypass.
  - Before resuming: capture **per department** (smaller, steadier result sets)
    and reconcile unique orders against the portal's per-department totals,
    because a date-sorted listing with many same-date orders repeats and skips
    rows between pages.
  - After each batch: `db:load` → build pages/chunks → `embed:chunks`, so new
    orders become searchable.
  - Disk: decide whether to keep all originals locally or only in B2 (with
    local cache eviction after the B2 sha256 check).
- Other official sources: `upgov`, `invest-up`, `uppolice` adapters built;
  `doe-gfr` ingested. The submission queue (people paste GO links/IDs) is not yet built.
- Official bulk request to NIC / the department: to be drafted by Abhishek.
- Storage cost: B2 $6.95/TB/month and the first 10 GB free, so the full portal is about $1–2/month.

## 4. Models

- Live chat stays on Qwen3-8B-4bit (MLX) on the M5 MacBook Air.
- Qwen3.8-27B (dense, Apache-2.0, Aug 2026): about 16–19 GB at 4-bit. It needs a
  24 GB Mac as a minimum and 32 GB to be comfortable. On the Air's 153 GB/s memory
  it would write only ~5–8 tokens/s, so a 900-token answer plus repair would take
  several minutes. Not used for live chat on the Air. Possible later uses: an
  overnight batch job (order titles/summaries, eval judging) or a hosted
  deployment.
- Retest candidates with `npm run eval:rag` before switching.

## 5. Hosting / production

- Not started. Time zone is already configurable (`APP_TIME_ZONE`,
  `NEXT_PUBLIC_APP_TIME_ZONE`). Needs hosted inference, managed Postgres with
  pgvector, auth, and backups.

## 6. Code comments

- Ongoing: every file we touch gets a header and "why" comments per
  `docs/CODE_COMMENTING.md`. Do not do a mass rewrite; comment as we go.

## Route changes

- 26 Sept 2026: the search page is organised by department (Abhishek's request).
  Ingestion was paused by Abhishek after 1,025 orders were listed and 653 stored in B2.
