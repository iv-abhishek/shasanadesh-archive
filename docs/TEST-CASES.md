# Test cases (2 Oct 2026)

Two parts: Ask cases the eval runner checks automatically (`eval/rag-cases.json`), and
screen checks done by hand. Restart before testing:
`npm run dev:all -- --restart=retrieval,api,web` (and `npm run db:migrate` once for the LGD
code columns).

## A. Automatic (eval runner)

```
npm run eval:ask                                   # all 43 cases (~30–60 s each on the Mac)
npm run eval:ask -- --case followup-solar-portal   # one case
```

Reports go to `data/eval/runs/`. New on 2 Oct:

| Case id | Prompt | Must happen |
|---|---|---|
| seniority-medical-officers-education-profile | What are the seniority rules for medical officers? *(profile: Secondary Education, Agriculture, PWD)* | Cites the Medical Officer service rules (25#201#2#2020); never the Registration Manual |
| seniority-medical-officers-hindi | चिकित्साधिकारियों की ज्येष्ठता के नियम क्या हैं? | Same, in Hindi |
| followup-solar-competent-authority | सोलर पंप लगवाने हेतु क्या प्रक्रिया है? → *click* इस आदेश में सक्षम प्राधिकारी कौन है? | Only the PM-KUSUM order(s), or "उद्धृत आदेशों में … उत्तर नहीं है"; never Vitta Path |
| followup-solar-portal | (same first question) → सोलर पंप के लिए आवेदन करने के लिए कौन सा पोर्टल उपलब्ध है? | Answer from the PM-KUSUM order, mentions पोर्टल |
| followup-medical-promotion-character | medical officers seniority → What is the procedure for verifying the character and suitability of candidates for promotion? | Stays on the Medical Officer rules; never the Registration Manual |
| followup-later-amendment | solar pump → क्या इस आदेश में बाद में कोई संशोधन हुआ है? | Answer from order links about the cited order only |
| fhb-fr56-superannuation | What is the age of superannuation under Fundamental Rule 56? | Cites Handbook Vol. II; link opens budget.up.nic.in |
| fhb-csr-qualifying-service | Civil Service Regulations के अनुसार पेंशन के लिए अर्हकारी सेवा क्या है? | Cites the CSR volume |
| vittapath-leave-hindi | वित्त पथ के अनुसार अर्जित अवकाश के नियम क्या हैं? | Readable Hindi (no Kruti Dev garble); source note about the font |
| go-number-content-pm-kusum | शासनादेश संख्या 61/2023/1100/12-5-2023/12-5099/24/2022 में क्या निर्देश हैं? | Answer from that order's pages, not an order list |
| list-revenue-latest | latest orders of revenue department | Order list, राजस्व विभाग |
| list-state-tax-hindi | राज्य कर विभाग के नवीनतम शासनादेश | Order list, राज्य कर |
| it-e-office-order | What does the e-office implementation order of IT and Electronics department say? | Cites an e-office GO |
| not-found-delhi-driving-licence | What is the procedure to get a driving licence in Delhi? | "No matching order", no sources |

Two-turn cases (`previousQuery`) ask the first question, then send the second as a clicked
suggestion (followUp + the first answer's cited orders), exactly as the web app does.

## B. By hand (screens)

| # | Where | Do | Pass when |
|---|---|---|---|
| 1 | Switch profile | Open it with 3 profiles | 5 boxes: 3 profiles, "New profile", 1 blank "Slot 5"; "3 of 5 profile slots used"; current profile marked |
| 2 | Switch profile | Fill all 5 slots | No "New profile" box; "All 5 profile slots are in use" |
| 3 | New profile | Search "allahabad" in District (state UP) | Finds Prayagraj (प्रयागराज); "noida" finds Gautam Buddha Nagar; "UP" finds Uttar Pradesh |
| 4 | New profile | State "Central Government / Other" | District says "Not applicable" |
| 5 | Departments | Search "krishi", "pwd", "आईटी", "stamp" | One entry each; no duplicates anywhere in the list (96 departments) |
| 6 | Departments | Tick 3, press Main on the 2nd, mark the 1st Addl. charge, remove the Main one | Main moves to the next eligible; chips update; 3/12 counter |
| 7 | Departments | हिन्दी / English switch | Names swap language in list, chips, sidebar; choice remembered after reload |
| 8 | Profile editor | Open it | "Answers and search" (language, default scope) is the first section |
| 9 | Answer | Ask the solar pump question | Numbered headings read 1, 2, 3 (not all "1."); suggestions have no stray `",?` |
| 10 | Answer | Click any suggestion | Sources are only the orders cited above; otherwise the "उद्धृत आदेशों में उत्तर नहीं" message |
| 11 | Answer | Latency breakdown | Generation well under 2 min with other apps closed (305 s seen under swap) |
| 12 | Safari | Repeat 9 in Safari | Same layout as Chrome |
