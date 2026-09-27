# Snapshot (generated)

Generated 27 Sept 2026, 3:47 pm (Asia/Kolkata) by `npm run handoff:snapshot`. Do not edit by hand.

## Git

- Branch: `main`
- HEAD: `d2f4e5e feat(ingest): Shasanadesh portal bridge and importer (as used for the first capture)`
- Unpushed commits: 2

Uncommitted files:

```
M README.md
 M apps/web/app/api/rag/pdf/route.ts
 M docs/DECISIONS.md
 M handoff/LOG.md
 M handoff/STATUS.md
 M package.json
 M scripts/shasanadesh-portal-bridge.mjs
 M src/ingest-portal.ts
?? scripts/portal-report.mjs
```

Recent commits:

```
d2f4e5e feat(ingest): Shasanadesh portal bridge and importer (as used for the first capture)
d060925 feat(ask): unchecked draft preview while answering; hosted-model switch
b350f11 feat(eval): 24-case Ask regression set; detect broken-conjunct text for OCR
37f87b5 fix(validation): keep trailing citations with their sentence; no citation-only answers
859caaa fix(ask): answers never end mid-word; larger Hindi token budget
90c3496 fix(ask): relevance gate, department fallback, honest "not found", cited-only sources
6a5a0c0 fix: build:pages skips routine orders; "Text indexed" means searchable chunks
aac3e75 feat: classify orders before processing; Ask leaves out routine orders; Copy reference
2bc6720 docs(roadmap): confirm decisions — all-department audience, UP core first, hosting plan
7c6ba03 docs: product roadmap — Ask-only for end users, guideline-focused corpus, daily sync
ce703d2 feat(search): "Browse all orders" — portal-style complete listing with filters and pages
a965553 feat(search): organise results by department; ID-based department matching; handoff files
1b139de Shasanadesh ingestion
68e944e feat: IST display time zone, legacy-font garble detection, Hindi fallback
7c9926b feat(web): question timestamps and answer actions (copy, listen, feedback, regenerate)
```

## Corpus by source

| Provider | Documents | In B2 | Pages | Selective-OCR pages |
|---|---:|---:|---:|---:|
| doe-gfr | 1 | 1 | 7 | 0 |
| shasanadesh-up | 678 | 677 | 445 | 192 |

- Retrieval variant chunks: 1084
- B2 configured: yes
- Submission queue entries: 0
- Shasanadesh crawl: not started

## Shasanadesh portal capture

- Listing: 1025 unique orders from 11 result pages
- In B2: 653 · not yet stored: 372 · retrying: 0 · unavailable (404/410): 0
- Listing complete: no
