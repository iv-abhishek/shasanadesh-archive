# Product Roadmap

**Status:** Draft for Abhishek to confirm, 26 Sept 2026. Supersedes the milestone
list in [PRODUCT_PLAN.md](PRODUCT_PLAN.md); the principles in
[PRODUCT_VISION.md](PRODUCT_VISION.md) still apply.
**Live progress:** [handoff/STATUS.md](../handoff/STATUS.md) · **Current routes:** [handoff/PLAN.md](../handoff/PLAN.md)

## 1. The product in one line

A bilingual (Hindi/English) assistant that officials can **talk to about the rules,
guidelines and procedures they use every day**. It answers from central and Uttar
Pradesh government documents and cites the exact page, linking to the **official
source**.

## 2. Direction decided on 26 Sept 2026

| Topic | Decision |
|---|---|
| End-user surface | **Ask** (conversation) only. The Search/Browse page is an **internal archive console** for the team, not shown to end users. |
| Corpus focus | **Guidelines, rules, procedures, OMs, circulars and manuals**, central first-class alongside UP. Budget releases, individual sanctions, transfers and jail orders are archived but **not** used for Ask by default. |
| Citations | Every cited page links to the **official URL** of the document (e.g. the Shasanadesh `ViewGOPDF` link, the ministry's PDF). Our archived copy is a labelled fallback ("archived copy, captured on …") when the official link is down. The UI never presents itself as a government site. |
| Freshness | After the backfill, every source is **synced daily** (§5). |
| Storage | All originals and manifests are kept in B2, separated by collection. Cost is negligible (~$1–2/month for the full UP portal). |

## 3. How the PDFs power Ask

```
official site ──► original PDF (B2, immutable, sha256)
                   │
                   ├─► metadata: issuer, department, section, category, GO no., date, subject
                   ├─► page text: native + OCR variants (quality-checked)
                   ├─► document type + usefulness tier   ◄── NEW (Phase 1)
                   ├─► relationships: amends / supersedes / refers to   ◄── NEW (Phase 3)
                   └─► chunks ─► embeddings (pgvector) + lexical index
                                         │
question ─► retrieve pages (tier-A first, profile departments, recency, not superseded)
        ─► rerank ─► model writes an answer ONLY from those pages
        ─► safety gate (citations, numbers must appear on a reliable cited page)
        ─► answer with [S1 p.3] ─► click opens the official link (+ page preview)
```

The model never "knows" the orders. It reads the retrieved pages and has to cite them,
so the corpus and its metadata decide the answer quality.

## 4. Separating useful guidelines from routine orders

Measured on the first 654 portal captures (26 Sept): **~57% are financial sanctions or
budget releases** (e.g. "आयोजनागत वित्तीय स्वीकृति" 266, "आयोजनेत्तर वित्तीय स्वीकृति" 31,
"बजट" 14). Only 6 are tagged "नीतियों/योजनाओं संबंधी दिशा-निर्देश". About 117 are prison
orders, and 227 are "अन्य/विविध" or "सामान्य" (other/general), which need a closer look.

Classification in three passes, all offline and batch:

1. **Rules on portal metadata**: the portal's category plus subject keywords
   (वित्तीय स्वीकृति / अवमुक्त / आवंटन → budget; नियमावली / दिशा-निर्देश / नीति / प्रक्रिया /
   संशोधन / स्पष्टीकरण → guideline candidate; कारागार / समयपूर्व रिहाई → case-specific).
   Cheap, and it settles most orders.
2. **Model pass** for the rest: the local Qwen3-8B (or the 27B overnight) reads the
   subject + first page and assigns a **type** (rules/guideline, policy/scheme,
   procedure/clarification, circular/OM, notification, individual/case order,
   sanction/budget) and a **tier**:
   - **A: generally applicable** (used by Ask by default)
   - **B: context** (scheme-specific, useful when asked directly)
   - **C: routine or individual** (archived, excluded from Ask unless the user names the order)
3. **Human review** of a sample and of borderline cases in the internal console, with
   precision tracked on a labelled set of 300 orders before the tier is trusted.

No order is deleted. The tier is a retrieval setting, so it can be corrected later.

## 5. Daily ingestion (after the backfill)

| Source | Daily method | Human step |
|---|---|---|
| UP Shasanadesh portal | Open the newest results through the bridge and stop at the first order already archived; the importer does the rest | ~2 minutes a day to complete the search CAPTCHA (it is never automated). **Better:** ask NIC/the department for a feed or bulk export (Phase 2 action). |
| Central ministries (DoE, DoPT, …) and other state sites | Source adapters on a schedule, respecting robots.txt and rate limits | None |

Each daily run: discover → download → B2 → extract/OCR → classify → chunk → embed →
available in Ask, and ends with a report (new, failed, unavailable, needs review). It
runs on a small server, not the MacBook Air.

## 6. Phases

### Phase 0: Stabilise the pilot (now, ~1 week)
- OCR rerun for garbled pages; `db:load` + embed the captured portal orders.
- Commit and review the portal bridge/importer; per-department capture with
  completeness reconciliation (the listing repeats and skips rows between pages).
- Build the eval set: 100–150 real questions (Hindi + English) with the correct page.
- **Exit:** eval baseline recorded; STATUS/PLAN current.

### Phase 1: Corpus quality and classification (~3–4 weeks)
- Document type + tier (§4); bilingual department registry (department ID → English + Hindi).
- Normalised metadata: issuer, jurisdiction (central/state), document type, dates.
- Resume UP backfill **department by department**, prioritising departments rich in
  guidelines (Personnel, Finance, General Administration, the officers' own departments).
- Local disk policy: keep originals in B2 and a local cache only.
- **Exit:** tier precision ≥ 90% on the labelled set; Ask retrieves tier A by default.

### Phase 2: Central guidelines corpus (~4–6 weeks, overlaps Phase 1)
- Source registry and adapters, one at a time. Candidates to inventory first:
  Department of Expenditure (GFR, delegation of financial powers, procurement manuals,
  OMs), DoPT (service-matter OMs), CVC circulars, e-Gazette notifications, India Code
  (Acts and Rules). Record owner, document types, access method and limits for each.
- Daily sync for every adapter (§5); NIC/department data request for Shasanadesh.
- **Exit:** at least 3 central sources syncing daily; new documents appear in Ask within 24 h.

### Phase 3: Ask v1 for end users (~4 weeks)
- Retrieval: tier-A first, profile departments, central vs state awareness, recency.
- **Relationships:** extract "in supersession of / संशोधन / अतिक्रमण में" references so
  answers prefer the current version and say when an order was amended.
- Citations open the official link; archived copy as a labelled fallback; disclaimer.
- Conversation quality: follow-ups, "explain simply", Hindi throughout, and answer templates
  for "what is the procedure / who is competent / what is the limit".
- Feedback loop: thumbs-down → review → eval set.
- **Exit:** on the eval set, ≥ 90% of answers cite a correct page and ≤ 2% contain an
  unsupported number or date; median answer time within the hosting target.

### Phase 4: Production (~3–4 weeks)
- Hosting: API + Postgres/pgvector + retrieval service on a server; generation on a
  hosted GPU or model API (the Air stays a dev machine).
- Identity: sign-in, public vs official profiles, server-side authorisation; the
  archive console restricted to admins.
- Operations: daily ingestion jobs, monitoring, backups (Postgres and B2), cost tracking.
- **Legal review before launch:** reuse and attribution of government documents,
  disclaimer wording, privacy notice, data retention.
- **Exit:** a closed pilot with 10–20 officials from 2–3 departments.

### Phase 5: Pilot → launch (ongoing)
- Weekly review of feedback and failed questions; add sources on demand.
- Later: more states, alerts ("new guideline in my department"), saved answers.

## 7. Decisions still open (for Abhishek)

1. **Launch audience:** UP officials only, all officials (central + states), or also the public?
2. **Order of corpus work:** central guidelines first, or UP guidelines first?
3. **Hosting budget** for generation (hosted GPU vs a model API), which sets speed and cost.
4. **Tier B/C in Ask:** fully excluded, or allowed when the user asks about a specific
   scheme or order number? (Draft: allowed only on explicit request.)
5. **Official data request** to NIC for Shasanadesh: who sends it, and when?

## 8. Risks

| Risk | Mitigation |
|---|---|
| Wrong or outdated guidance cited | Supersession links, recency, "verify on the official source" disclaimer, visible dates |
| Garbled Hindi text layers | Garble detection + OCR variants (done); keep both variants |
| Portal access changes / CAPTCHA | Human-in-the-loop only; pursue an official feed |
| Classification errors hide useful orders | Tiers are reversible settings; human review; eval |
| Legal/reputational | Link to official sources, never imitate a government site, legal review before launch |
| Running cost of generation | Small model for routine answers; larger model only where needed |
