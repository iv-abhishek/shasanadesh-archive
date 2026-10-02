# Plan

The product roadmap (phases, decisions, open questions) is [docs/ROADMAP.md](../docs/ROADMAP.md).
This file tracks the current route per workstream.

The roadmap and the current route for each workstream. When a route changes,
edit it here and say why (with the date) under "Route changes".

**Product name (decided 2 Oct 2026, Abhishek): Sandarbh (संदर्भ), domain sandarbh.ai.**
Indian backup sandarbh.co.in; avoid "sandarbhai" (reads "sandar bhai"); write "Sandarbh AI" with
"AI" visually apart. Not to be named like a government app (no Saathi/Mitra/Setu/gov). The
interface is renamed from "Shasanadesh Assistant" once the domain is bought; code and folders keep
their names.

## 0. The to-do list (set 27 Sept 2026, Abhishek; keep this current)

**Goal:** an LLM for government functionaries and systems: fluent in government language
and regional text, answering and solving problems from evidence, learning from daily use.
**Rules that hold for everything below:** government sources only, official URLs in chat
(docs/RULES.md); robots.txt obeyed; CAPTCHAs never automated; central + UP now, other
states later. Hosting is not a blocker (public documents, cited by URL); pilot on the Mac.

### A. Finish the product on the Mac (in this order)

1. **Corpus batch 2**: ingest the 70 new catalogue entries (complete Make in India, MSE,
   procurement OMs, CVC, CSMOP, RTI, records, grievances, RPwD, CCS rules, accounts,
   MeitY, UP Procurement Manual); manual downloads per NEEDED.md; verify MII numbers
   against the texts; OCR scanned ones.
2. **UP rulebooks**: reader for the HTML Financial Handbook volumes + CSR (cited per
   chapter), Vol. VI PDFs; three UP GOs from Shasanadesh (Abhishek): MSE procurement policy
   2020, e-tender GO, Procurement Manual GO. (Both listed in NEEDED.md.)
3. **Ask quality pack**: current above superseded; narrow orders out; thumbs-down → eval
   cases; eval baseline. Done 27 Sept: follow-up chips, auto-archive, clean "Searching …"
   line.
4. **Procurement system** (docs/PROCUREMENT.md): applicability UP vs central, reviewed
   facts table, procurement guide, Make in India check, 50-question eval.
5. **Letter drafting**: letters, notes and replies in government format from cited orders.
6. **Sign-in and admin**: accounts, roles, feedback review, source management.
7. **Pilot on the Mac**: daily sync scheduled, backups, LAN access for pilot users,
   performance check.

### B. Corpus: every rulebook officials use (domain by domain)

For each domain: acts + rules + manuals + current circulars + FAQs, central and UP, in the
catalogue (reviewed), each edition marked current / superseded / draft.

| Priority | Domain | Central | UP |
|---|---|---|---|
| 1 | GeM and procurement | GeM rules, GTC, buyer/seller manuals, **GeM FAQs**, SOPs, incident management | UP GeM GOs, Procurement Manual, e-tender |
| 1 | Audit and accounts | **CAG** Auditing Standards, Regulations on Audit & Accounts 2020, audit manuals | AG UP, Local Fund Audit, treasury rules |
| 1 | Labour, **PF, ESI**, **outsourcing** | Labour Codes (Wages, IR, SS, OSH) + rules; EPF Act/Scheme + EPFO circulars; ESI Act + ESIC circulars; Contract Labour; GeM manpower outsourcing | UP labour rules; UP outsourcing policy / UP Outsource Sewa Nigam |
| 2 | **Education** | MoE, NEP 2020, RTE Act, **Samagra Shiksha** framework, norms, FAQs | Basic, Secondary, Higher education GOs; UP RTE Rules |
| 2 | **Health** and **AYUSH** | NHM guidelines, AYUSH ministry schemes and rules | UP health, medical education, AYUSH GOs |
| 2 | **RTI** | Act, Rules, DoPT OMs, **FAQs**, CIC guidance | UP RTI Rules, UP Information Commission |
| 2 | **Panchayati Raj** and **municipalities** | 73rd/74th amendments, MoPR guidelines, Finance Commission grant rules | UP Panchayat Raj Act 1947, Kshetra/Zila Panchayat Act 1961, Municipalities Act 1916, Municipal Corporation Act 1959 + rules |
| 3 | **Police** and criminal law | BNS, BNSS, BSA 2023; MHA advisories | UP Police Regulations, police GOs (uppolice adapter) |
| 3 | **Courts** | Supreme Court judgments on service/procurement matters | Allahabad High Court (its official domain is not .gov.in: needs an approved exception) |
| 3 | Service and pay | DoPT, 7th CPC, leave, pension (CCS Pension) | UP service rules, Financial Handbook Vol. II |

### C. Department knowledge: what each department does

A polite crawler (government hosts, robots.txt, sitemaps, crawl delay) reads ministry and
department websites (functions, allocation of business, citizen charter, schemes,
organisation, helplines, FAQ) into a **department profile**, so Ask can answer "who handles
X", route a question to the right rules, and find new documents. New PDFs go to a review
queue (classified, tiered), not straight into answers.

### D. Problem-solving conversation

- Case mode: the officer describes a situation → applicable rules, steps, forms, deadlines,
  who approves, each with evidence; asks a clarifying question when the facts decide the
  rule (value, department, central or UP).
- Evidence panel, checklists, letter/note drafting from the same evidence.
- Regional text: Hindi, Hinglish, legacy-font Hindi (Kruti Dev) read correctly; answers in
  the officer's language.

### E. Self-learning (supervised, never blind)

1. Every answer, thumbs-down and correction is logged (DPDP: personal data removed).
2. Reviewed failures become eval cases; reviewed good answers become training examples;
   up/down pairs become preference data.
3. Periodic training on the Mac: retrieval (embeddings/reranker) on real question → page
   pairs; LoRA of the generator (Qwen3-8B, MLX) for government language, format and
   drafting.
4. A new model ships only if it beats the eval sets. Facts stay in retrieval (evidence);
   the model learns language and reasoning, not unverified facts.

### F. The government LLM

- Corpus in B2 (Rulebook §1: our data is used for modelling) → continued pre-training on
  government Hindi/English text; instruction data from validated conversations.
- Benchmark: the eval sets grow into a public-sector benchmark (UP + central, Hindi +
  English, procurement, service, finance, RTI …).
- Larger base model and India GPU hosting at production; other states via the
  jurisdictions table.

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
  - Disk (decided 27 Sept, ADR-056): originals of routine orders only in B2, OCR images
    deleted, importers stop at `MIN_FREE_DISK_GB`; `storage:restore` brings originals back.
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

- 26 Sept 2026, 7:45 pm: product direction set: Ask is the only end-user surface,
  Search/Browse is internal; corpus focus is guidelines (central + UP); routine orders
  are classified into tiers and excluded from Ask by default; citations link to
  official URLs; daily sync after backfill. Roadmap drafted in docs/ROADMAP.md,
  with 5 open decisions awaiting Abhishek.
- 26 Sept 2026, 8:45 pm: classification rules pass built (ADR-046); heavy steps and chat skip
  confident tier C. Next: model pass for low-confidence orders + console review action.
- 26 Sept 2026, 8:10 pm: decisions confirmed (ROADMAP §7). New route: classify orders
  from the portal listing first and fully process (OCR/embeddings) only tier A/B; UP core
  before central; "Copy reference" citation line is a Phase 3 must-have.

- 26 Sept 2026: the search page is organised by department (Abhishek's request).
  Ingestion was paused by Abhishek after 1,025 orders were listed and 653 stored in B2.
