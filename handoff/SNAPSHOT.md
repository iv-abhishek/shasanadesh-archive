# Snapshot (generated)

Generated 26 Sept 2026, 10:55 pm (Asia/Kolkata) by `npm run handoff:snapshot`. Do not edit by hand.

## Git

- Branch: `main`
- HEAD: `37f87b5 fix(validation): keep trailing citations with their sentence; no citation-only answers`
- Unpushed commits: 0

Uncommitted files:

```
M README.md
 M apps/web/lib/sources.ts
 M docs/DECISIONS.md
 M docs/EVALUATION.md
 M eval/rag-cases.json
 M handoff/LOG.md
 M handoff/STATUS.md
 M package.json
 M src/eval/run-rag-eval.ts
 M src/lib/text-quality.test.ts
 M src/lib/text-quality.ts
?? scripts/shasanadesh-portal-bridge.mjs
?? src/ingest-portal.ts
```

Recent commits:

```
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
253af98 feat(api): answer feedback, in-place regenerate, feedback report
b51e84a fix(web): EN/HI toggle no longer turns green on hover
6d5d23a feat(web): pin the chat composer to the bottom; configurable rerank count
```

## Corpus by source

| Provider | Documents | In B2 | Pages | Selective-OCR pages |
|---|---:|---:|---:|---:|
| doe-gfr | 1 | 1 | 7 | 0 |
| shasanadesh-up | 678 | 677 | 445 | 92 |

- Retrieval variant chunks: 901
- B2 configured: yes
- Submission queue entries: 0
- Shasanadesh crawl: not started

## Shasanadesh portal capture

- Listing: 1025 unique orders from 11 result pages
- In B2: 653 · not yet stored: 372 · retrying: 0 · unavailable (404/410): 0
- Listing complete: no
