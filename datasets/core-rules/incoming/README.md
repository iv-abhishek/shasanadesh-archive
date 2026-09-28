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
- 2026-09-28-retry-1.json: MHA advisories (Section 479 BNSS, 01.01.2025; police training,
  30.04.2024), 16th FC rural local body guidelines 2026–31 (supersedes the 15th FC ones), FBNC
  guidelines 2025, CAG Auditing Standards 2017, CCS (Pension) Amendment Rules 2024 (unverified).
  Still missing (dead links or none): NEP 2020, Samagra Shiksha framework, RTE (Second
  Amendment) Rules 2017, NCISM Act 2020, Code on Wages 2019, Code on Social Security 2020,
  CCS (Pension) Rules 2021, UP Police Regulations, UP Panchayat Raj Rules, 15th FC ULB guidelines.
- 2026-09-28-gem.json: GeM buyer and seller user manuals, GeM handbook, incident management
  policy (assets-bg.gem.gov.in: blocked outside India, not checked here; paths under
  /resources/upload/shared_doc/ are disallowed by robots.txt and go to NEEDED.md).
- 2026-09-28-up-service-rules.json: UP Government Servant (Discipline and Appeal) Rules 1999
  (uppolice.gov.in copy). The Financial Handbook Vol. II (UP FR/SR, leave) and Vol. III (TA)
  are HTML on budget.up.nic.in: they come in through the Financial Handbook reader (PLAN §0 A2).
  No official PDF found: UP Seniority Rules 1991, UP Retirement Benefits Rules 1961.
- 2026-09-28-up-procurement-msme.json: UP MSME Promotion Policy 2022 (English), startup
  procurement relaxation GO 11.03.2019, MSE/startup performance-security GO 31.05.2021.
  Refused under Rulebook §2 (host is not a government domain): UP MSE Purchase Policy 2020 GO
  and the e-tendering GOs of 24.04.2018 and 26.07.2018 (ntender.gdaghaziabad.in), the UP
  Procurement Manual copy on www.uplc.in. Startup (First Amendment) Policy 2022: link returned
  HTTP 500.
- 2026-09-28-vigilance-up-health-education.json: UP Lokayukta Act 1975 (India Code) and the Hindi
  compilation with rules and notifications (lokayukta.up.nic.in), Prevention of Corruption Act
  1988 (as on 21.05.2025), UP RTE Rules 2011, NHM UP PIP approval 2024–26, PM-JAY operation
  manual and empanelment/de-empanelment guidelines. No PDF link given: CVC master circulars
  2026 (complaints, vigilance angle, CVO role, PIDPI, sanction for prosecution), UP Vigilance
  Establishment Act 1965, Manav Sampada property-return order 23.08.2023, NHM UP DHAP 2025-26.
- 2026-09-28 six batches (land & revenue, UP finance/treasury, transfers/e-office/IGRS, rural
  development, central personnel, disaster/DBT/Aadhaar): 34 entries. Left out: Treasury Rules,
  Treasury Manual and Financial Handbook Vol. V (web pages: Handbook reader), MGNREGA master
  circular 2020-21 (404), duplicate UP Budget Manual; no link given for e-office mandatory
  processing 09.12.2025, IGRS GO 02.01.2024, DM (Amendment) Act 2025, Aadhaar good-governance
  rules 2020, UP IT/ITeS policy amendment 2026, UP Data Centre Policy 2026. The central GPF
  entry is the 2022 amendment (₹5 lakh ceiling), not the full 1960 Rules.
- 2026-09-28 six batches (food/social welfare, women & child, urban/housing, environment/
  forest/mining, transport/energy/industry, cooperatives/excise/consumer): 39 entries. Refused
  (not a government domain): UP RERA Rules (up-rera.in), SBM-U 2.0 guidelines (swminfo.in),
  Smart Cities guidelines (sscm.uphq.in), UP Urban Planning Act 1973 and bylaw amendments
  (awasbandhu.in), UP Electricity Supply Code + 13th amendment (uperc.org). Dead link: TPDS
  (Control) Order 2015. No link: TPDS amendment 2025, Poshan 2.0 revision, UP Urban Planning
  (Amendment) Act 2023, Water Act 1974, Van Rules 2023, EIA Notification 2006, Legal Metrology
  Act 2009.
