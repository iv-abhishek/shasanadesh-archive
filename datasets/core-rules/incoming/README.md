# Incoming catalogue entries

Drop a JSON file here (a list of entries in the catalogue format, e.g. a reply prepared with
another assistant). `npm run ingest:source -- core-rules` reads these files after
`../catalogue.json`; `npm run test:sources` validates them together (government links only,
known topic codes, unique slugs). One file per batch, named by date and topic.

- 2026-09-28-labour-epf-esi-cag.json: EPF Act/Scheme, EPS 1995, EDLI 1976, ESI Act, IR and OSH
  codes, the four Central Rules 2026 of the labour codes, CAG Regulations 2020 and DPC Act
  1971, UP Outsource Sewa Nigam GO (19.09.2025). Left out for now (no working official PDF
  link): Code on Wages 2019 and Code on Social Security 2020 (labour.gov.in links return 404),
  CAG Auditing Standards (the link was a web page, not a PDF).
