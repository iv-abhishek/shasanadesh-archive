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

## Current collection (27 Sept 2026, 95 documents)

| Area | Documents |
|---|---|
| Central financial rules | GFR 2017 (to 31.01.2026) + amendments 10.07.2024, Rule 144(xi) 23.02.2023, Rule 151 08.05.2026; DFPR 2024; Union Budget Manual 2022; Civil Accounts Manual 2024; Receipts and Payments Rules 2022 |
| Central procurement | Manuals: Goods 2024, Works 2025 (+ amendment 18.06.2026), Consultancy 2025, Non-Consultancy 2025; debarment 2021 (+ 2026); performance security 2021; force majeure, PPI price variation, wages, consultancy evaluation (2026); GeM OM 2021; arbitration & mediation 2024; land-border Order PP No. 4 (2023, supersedes 2020), OM to States 2023; GTE consolidated 2021 + drugs/devices relaxations 2025 |
| Make in India | Order 19.07.2024 (current; supersedes 2017, 2018, 2019, 04.06.2020, 16.09.2020, all kept as superseded) + OM 08.07.2025; local-content clarification 2021; two FAQs; Standing Committee minutes (14th, 17th); Appendix-A; notifications of DoT, MeitY (phones), Steel (DMI&SP 2025), MHI (boilers, automobiles), DoP (medical devices), MNRE, Defence, Railways (S&T) |
| MSE | MSE Order 2012 + amendments 2018, 2021, 2022 |
| GeM | GTC on GeM 4.0 v1.26; UP GeM GOs 05.08.2017, 23.08.2017, 26.11.2024, 11.03.2025, 21.07.2025 |
| Vigilance | CVC Vigilance Manual 2026 (9th ed.); Integrity Pact SOP 2023 + circular 09/2023 + corrigendum 2025 |
| Office, RTI, grievances, accessibility | CSMOP 2022 (English, Hindi); RTI Act 2005, RTI Rules 2012, 2019; Public Records Act 1993, Rules 1997; DARPG grievance guidelines 2024; RPwD Act 2016, Rules 2017, amendment 2024 |
| Service (central) | CCS (Conduct) Rules 1964, CCS (CCA) Rules 1965 (DoPT consolidations) |
| Digital, data, cyber | DPDP Act 2023, Rules 2025; CERT-In directions 2022, guidelines 2023; GIGW 3.0; Open API; OSS; Open Data Licence 2017; Email Policy 2024; NCSP 2013; cloud procurement guidelines 2026; GI Cloud reference architecture 2026; DBIM 3.0; NDGFP (**draft**, never final) |
| UP | Budget Manual (Ch. I–XIX); Conduct Rules 1956; Procurement Manual (Goods) 2016 |

Fields beyond the basics: `supersedes` (earlier editions → status superseded),
`status: "draft" | "historical"`.

## Next candidates

- UP Financial Handbook volumes and CSR (HTML only on budget.up.nic.in; needs an HTML
  adapter), Vol. VI chapter PDFs; UP MSE purchase policy 2020, e-tender GO and the
  Procurement Manual GO (from Shasanadesh); UP Discipline & Appeal Rules 1999.
- Not found on a government host yet: the 2013 GI Cloud roadmap, the CVC procurement
  compendium (old URLs dead), MeitY cyber-security-products MII order, Power/MoRTH MII
  notifications, DPIIT clarifications of 2019–2023 listed only by aggregators.

Note (from Abhishek's list): Union finance and procurement rules are not automatically UP
rules; Ask says so when it relies on a central document for a UP question (ADR-064).

## Capture from Shasanadesh (with the bridge bookmark)

The UP GeM orders above are district-site copies; capture the issuing department's copy:
department **सूक्ष्म, लघु एवं मध्यम उद्यम** (section 2) and **आई.टी. एवं इलेक्ट्रॉनिक्स**,
subject words **जेम** / **GeM**; and department **वित्त**, subject words **ई-प्रोक्योरमेंट** /
**ई-टेण्डरिंग** / **क्रय**. Once captured, the portal copy is preferred (`preferredSource`).
