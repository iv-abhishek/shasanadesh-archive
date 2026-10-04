# Knowledge sources and their order (ADR-096, ADR-097)

Sandarbh answers government questions from four layers, in this order. A lower layer is
used only when the higher ones do not answer, and the answer always says which layer it
came from.

| # | Layer | What | Updated | Shown as |
|---|---|---|---|---|
| 1 | **Archive** | Rulebooks and acts (GFR, FHB, manuals, service rules); UP GOs from Shasanadesh | Shasanadesh: owner's capture every 15 days; rulebooks when amended | Cited pages with official links |
| 2 | **Crawled official documents** | Documents from a register of official websites (UP departments, directorates, districts, central ministries), admitted by the rules below | Crawler: listing pages daily/weekly | Cited pages, labelled with the issuing office |
| 3 | **Live official web** | One search of government websites (UP sites first, then central; other states dropped) | At question time | "Official websites (live search)" badge; cited pages |
| 4 | **General knowledge** | The model's own knowledge, no figures or rule numbers | — | "General knowledge" note |

## Authority inside an answer

Act / statutory rules › rulebooks (GFR, FHB, CSR, manuals) › State GOs › department and
directorate circulars › district notices. For procurement, the order in ADR-093 applies
(UP GeM GO › GeM GTC › GFR › manuals › UP Procurement Manual 2016). A rule printed in an
old rulebook and later changed is answered as current position + printed rule + amending
GO (ADR-094). A central rule is said to be central; it applies to UP staff only if a UP
order adopts it.

## Admission rules for crawled documents (layer 2)

Every crawled document is classified (the existing model pass) into:

- **level**: central · state headquarters (Secretariat / department) · directorate ·
  division · district
- **kind**: act/rules · GO · circular/guideline · policy/scheme guideline · budget
  release/sanction · notice · report/data
- **tier**: A general rule · B useful in context · C routine/individual (as for
  Shasanadesh, ADR-046)

| Kind | Kept? | Used for |
|---|---|---|
| Act, rules, GO, circular, guideline, policy, scheme guideline | Yes | Answers |
| Budget release / financial sanction | Yes, as records | Listing questions ("funds released for X in 2026-27"), not rule answers |
| Report, statistics | Yes, tier B | Answers on request |
| Tender, recruitment result, merit list, event, press note, photo gallery, RTI list, individual transfer/posting | **No** (link kept in the crawl log only) | — |

## Who sees what (visibility)

- **Headquarters officers** (default): central, state headquarters and directorate
  documents. District documents are not used.
- **District documents** are used only when the question names a district, or the
  officer's profile has a district (LGD code, migration 013).
- Tier C (routine/individual) documents only answer listing or "find this order" questions,
  never rule questions (as for Shasanadesh).

## Crawler rules

Official sites only (register in `datasets/crawl/sites.json`, reviewed by the owner before
a site is crawled); robots.txt obeyed; one request every few seconds per site; a clear
user agent with contact; no CAPTCHA or login pages (Shasanadesh stays with the owner's
capture); PDFs fetched once (they do not change); listing pages re-checked on a schedule.
Links found by the live web search (layer 3) are logged in `data/web-found/links.jsonl`
and reviewed for the register, so the archive grows from the questions officers ask.

## Running the crawler (ADR-103)

Run on the Mac (Indian connection; many UP sites refuse foreign IPs):

```
npm run crawl:check -- --priority 1        # read listing pages only; report in data/crawl/
# review the report, set "approved": true for the sites to keep in datasets/crawl/sites.json
caffeinate -i npm run crawl                # download and archive approved sites (incremental)
npm run sync:daily -- --ingest             # or let the daily sync pick them up, then process
```

Site fields beyond ADR-097: `docLinkPattern` (document links not ending in .pdf),
`followPattern` (index pages to follow one level), `maxPages` (default 20), `fileHosts`,
`coveredBy` (a dedicated adapter already reads the site). A site on a domain outside
.gov.in / .nic.in is refused until its host is added to `src/lib/government-hosts.ts` and
`apps/web/lib/government-hosts.ts`.

