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
- 2026-09-28-education-health-rti-local-bodies.json: RTE Act 2009, PM POSHAN guidelines, NCH Act
  2020, NHM framework, UP RTI Rules 2015, UP Panchayat Raj Act 1947, UP Kshetra/Zila Panchayat
  Adhiniyam 1961, 15th FC rural local body guidelines, UP Municipalities Act 1916, UP Municipal
  Corporation Act 1959. Left out (links dead or not PDFs when checked): RTE (Second Amendment)
  Rules 2017, NEP 2020, Samagra Shiksha framework, NCISM Act 2020, FBNC guidelines 2025, UP
  Panchayat Raj Rules, 16th FC rural local body guidelines, 15th FC urban local body guidelines.
- 2026-09-28-criminal-laws-service.json: BNS, BNSS, BSA 2023 (MHA), CCS (Leave) Rules 1972 (DoPT
  consolidation to 18.10.2023), FR/SR compilation, CCS (Revised Pay) Rules 2016. Left out: MHA
  advisories of 30.04.2024 and 29.04.2025 and the UP Police Regulations (links return 404),
  CCS (Pension) Rules 2021 (no PDF link given).
