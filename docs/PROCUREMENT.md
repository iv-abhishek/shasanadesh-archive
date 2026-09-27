# Procurement questions — design (27 Sept 2026)

Goal: any procurement question from a UP or central official gets a correct, current,
cited answer — which rule applies, the value limits, the procedure, Make in India and
MSE preferences, GeM, securities, debarment — in Hindi or English.

## 1. Corpus (what the answers stand on)

| Layer | Central (Government of India) | Uttar Pradesh |
|---|---|---|
| Rules | GFR 2017 (to 31.01.2026) + amendments of 10.07.2024, 23.02.2023 (Rule 144(xi)), 08.05.2026 (Rule 151); DFPR 2024 | Financial Handbook Vol. V Part I, Vol. VI (works) — *HTML adapter, step 2* |
| Manuals | Goods 2024, Works 2025 (+ amendment 18.06.2026), Consultancy 2025, Non-Consultancy 2025 | UP Procurement Manual (Goods) 2016 + GO 01.04.2016 |
| Make in India | Order 19.07.2024 (current) + OM 08.07.2025 (₹50 lakh research exemption); history 2017, 2018, 2019, 04.06.2020, 16.09.2020 (superseded); local-content clarification 04.03.2021; FAQs; Standing Committee minutes; Appendix-A (nodal ministries); ministry notifications (DoT, MeitY phones, Steel DMI&SP 2025, MHI boilers/automobiles, medical devices, MNRE, Defence, Railways S&T) | UP has no separate local-preference order found; central order applies to central procurement only |
| MSE | MSE Order 2012 + amendments 2018 (25%), 2021, 2022 | UP MSE procurement policy 2020 — *from Shasanadesh* |
| Border / GTE | Rule 144(xi): Order PP No. 4 (23.02.2023, current), OM to States 11.09.2023; GTE consolidated 03.08.2021 + drugs/devices relaxations | — |
| GeM | GTC 4.0 v1.26; DoE GeM OM 11.06.2021 | UP GeM GOs 2017, 26.11.2024 (+ 11.03.2025), forward auction 21.07.2025 |
| Contract terms | Debarment 2021 + 2026; performance security 2021; force majeure 2026; PPI price variation 2026; wages 2026; arbitration & mediation 2024; consultancy evaluation 2026 (+ corrigendum) | e-tender GO — *from Shasanadesh* |
| Integrity | CVC Integrity Pact SOP 2023 (+ 09/2023, corrigendum 2025); CVC Vigilance Manual 2026 | — |

Editions that were replaced stay searchable but are marked **Superseded** (catalogue
`supersedes`), so "what did the 2020 order say" works while current answers use the
current text.

## 2. Answering

1. **Applicability first.** A UP officer's question ("क्रय की सीमा क्या है?") is answered
   from UP rules (Procurement Manual, UP GeM GOs, Handbook); central rules are named only
   as "for Government of India procurement". A question naming the Centre, a ministry or
   a CPSE goes to central rules. The profile's government sets the default.
2. **Current version first.** Retrieval ranks `current` above `superseded`; an amendment
   is shown with the text it changes (order links).
3. **Numbers from a reviewed facts table** (`datasets/procurement/facts.json`): value
   limits, percentages, time limits and who approves — each with the document, page,
   quote and the date it took effect. Threshold questions are answered from the table
   (no generated numbers), with the citation opening the official page. The table is
   built by reading the ingested texts and checked by a test that each quote still
   appears on its cited page.
4. **Procurement guide** (Ask start page and follow-up chip): value + goods / works /
   services / consultancy + available on GeM? + central / UP → the mode of procurement,
   who approves, securities, MII/MSE conditions, each line cited.
5. **Make in India check**: local content % and value → Class-I / Class-II / non-local,
   whether purchase preference and the 20% margin apply, exemptions (₹5 lakh; ₹50 lakh for
   research institutions), Rule 144(xi) registration — from the order's paragraphs.
6. **Eval set**: 50 procurement questions (Hindi + English, UP + central, MII, MSE, GeM,
   thresholds, superseded-version traps) with expected documents and pages; must pass
   before calling this done.
