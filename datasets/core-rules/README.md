# Core rules and guidelines (curated)

`catalogue.json` lists the rulebooks, manuals and standing orders that officials cite
daily and that are not (only) on Shasanadesh (ADR-062). It is reviewed by hand; nothing
is crawled.

## Ingest

```
npm run ingest:source -- core-rules      # downloads only the catalogue URLs, B2: archive/core-rules/
npm run classify:orders                  # all entries become tier A
npm run sync:daily                       # or the processing steps: OCR, pages, chunks, relations, db:load, embed
```

## Add a document

1. Find the **issuer's own copy** (a `.gov.in` / `.nic.in` HTTPS URL). Aggregators
   (Scribd, StaffNews, law blogs) are not sources; use them only to discover the official URL.
2. Check it is the **current edition**: a newer edition or consolidated update replaces
   the entry (note what it supersedes in `sourceNote`).
3. Add an entry: `slug` (lowercase, dashes), `title` (+ `titleHi`), `issuer`,
   `jurisdiction` (`central` / `state`), `department` (UP department name, or null),
   `documentType` (`rules`, `guideline`, `policy`, `general-instruction`, …), `topics`,
   `edition`, `date` (YYYY-MM-DD or null), `goNumber`, `language`, `officialPage`,
   `downloadUrl`, `sourceNote` (provenance), optional `preferredSource` (the Shasanadesh
   GO this copies) and `amends` (slugs of entries it amends).
4. `npm run test:sources` validates the catalogue.

## Current collection (27 Sept 2026)

| Area | Documents |
|---|---|
| Central financial rules | GFR 2017 (updated to 31.01.2026), DFPR 2024 |
| Central procurement | Manuals for Goods (2nd ed. 2024), Works (2nd ed. 2025), Consultancy (2nd ed. 2025), Non-Consultancy Services (2025); Make in India order (revision 19.07.2024) |
| GeM | GTC on GeM 4.0 v1.26; UP GeM GOs of 05.08.2017, 23.08.2017, 26.11.2024, 11.03.2025 (amends 26.11.2024), 21.07.2025 (forward auction) |
| UP financial / service | UP Budget Manual (Ch. I–XIX), UP Government Servants' Conduct Rules 1956 |

## Next candidates (need an official PDF first)

- UP Financial Handbook Vol. I (delegation of financial powers), Vol. II parts 2–4
  (Fundamental Rules), Vol. V (accounts): officially online only as web pages
  (budget.up.nic.in, English, unrevised); needs HTML ingestion.
- UP Government Servants (Discipline and Appeal) Rules 1999, Seniority Rules 1991,
  leave, TA, medical reimbursement, GPF, pension rules (Personnel/Finance GOs).
- MSE Public Procurement Policy Order 2012 (as amended) — msme.gov.in loads its PDFs by script.
- UP e-procurement / e-tendering GOs and the UP procurement policy orders (Finance).
- CVC guidelines on public procurement.

## Capture from Shasanadesh (with the bridge bookmark)

The UP GeM orders above are district-site copies; capture the issuing department's copy:
department **सूक्ष्म, लघु एवं मध्यम उद्यम** (section 2) and **आई.टी. एवं इलेक्ट्रॉनिक्स**,
subject words **जेम** / **GeM**; and department **वित्त**, subject words **ई-प्रोक्योरमेंट** /
**ई-टेण्डरिंग** / **क्रय**. Once captured, the portal copy is preferred (`preferredSource`).
