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

## Current collection (27 Sept 2026, 25 documents)

| Area | Documents |
|---|---|
| Central financial rules | GFR 2017 (updated to 31.01.2026), DFPR 2024, Union Budget Manual 2022 |
| Central procurement | Manuals for Goods (2nd ed. 2024), Works (2nd ed. 2025), Consultancy (2nd ed. 2025), Non-Consultancy Services (2025); Make in India order (revision 19.07.2024); arbitration & mediation guidelines (OM 03.06.2024) |
| GeM | GTC on GeM 4.0 v1.26; UP GeM GOs of 05.08.2017, 23.08.2017, 26.11.2024, 11.03.2025 (amends 26.11.2024), 21.07.2025 (forward auction) |
| Digital, data, cyber (central) | DPDP Act 2023, DPDP Rules 2025, CERT-In Directions (28.04.2022), CERT-In guidelines for government entities (2023), GIGW 3.0, Open API policy, Open Source policy, Government Open Data License (2017) |
| UP financial / service | UP Budget Manual (Ch. I–XIX), UP Government Servants' Conduct Rules 1956 |

`topics` use the codes in `src/classify/topics.ts` (procurement, gem, financial-rules,
budget-accounts, service, conduct-discipline, digital-it, data-protection, cybersecurity, …).

## Next candidates (official PDF to be confirmed first)

Their sites list documents through scripts, so the file URL could not be confirmed from a
plain download; confirm each in a browser, then add it:

- Vigilance: CVC Vigilance Manual (updated 2021; cvc.gov.in), CVC Integrity Pact SOP.
- Accounts: Civil Accounts Manual (revised 4th ed. 2024) and Central Government Account
  (Receipts and Payments) Rules 2022 (cga.nic.in), List of Major and Minor Heads.
- Office: CSMOP 2022 (16th ed.), DARPG comprehensive grievance guidelines (OM 23.08.2024).
- Personnel (central): CCS (Conduct) Rules 1964, CCS (CCA) Rules 1965 (dopt.gov.in).
- Law: RTI Act 2005, Public Records Act 1993 and Rules 1997, RPwD Act 2016 and Rules 2017
  (indiacode.nic.in / nationalarchives.nic.in).
- Digital: Email Policy 2024, National Cyber Security Policy 2013, MeghRaj (GI Cloud),
  DBIM; National Data Governance Framework Policy only as `status: draft`.
- Procurement: MSE Public Procurement Policy Order 2012 (as amended).
- UP: Financial Handbook volumes (web pages only), Discipline & Appeal Rules 1999,
  Seniority Rules 1991, e-procurement GOs.

Note (from Abhishek's list): Union finance and procurement rules are not automatically UP
rules; Ask says so when it relies on a central document for a UP question (ADR-064).

## Capture from Shasanadesh (with the bridge bookmark)

The UP GeM orders above are district-site copies; capture the issuing department's copy:
department **सूक्ष्म, लघु एवं मध्यम उद्यम** (section 2) and **आई.टी. एवं इलेक्ट्रॉनिक्स**,
subject words **जेम** / **GeM**; and department **वित्त**, subject words **ई-प्रोक्योरमेंट** /
**ई-टेण्डरिंग** / **क्रय**. Once captured, the portal copy is preferred (`preferredSource`).
