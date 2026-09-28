# Shasanadesh — Hosting Plan (final)

*28–29 Sept 2026 · Claude, merging our current build with the ChatGPT "Optimized Architecture and Implementation Plan".
Replaces the recommendation in `docs/ROADMAP.md` §9. All prices are planning estimates checked in Sept 2026; confirm at purchase.*

---

## 1. The decision in one page

| Layer | Pilot (≤ 100 users) | Scale (≥ 1,000 users or IndiaAI GPU approved) |
|---|---|---|
| **Edge** | Cloudflare (DNS, TLS, WAF, rate limits) | same |
| **App server** | One VM (8 vCPU / 32 GB, Mumbai or Singapore), Docker Compose: Next.js web, Fastify API, Python retrieval service, Postgres + pgvector, daily sync worker | Same VM, larger; add a second one only if CPU-bound |
| **Answer model** | Open-weights Qwen through a pay-per-use API (OpenRouter / DeepInfra / Together) | Our own GPU (IndiaAI-subsidised H100) running **vLLM** |
| **Helper model** | **Jev** (routing, answerable check, passage ranking, citation check, bulk sorting) with rules as fallback | same |
| **Embeddings + reranker** | Qwen3-Embedding-0.6B + Qwen3-Reranker-0.6B on the VM's CPU (as today) | Move to the GPU box |
| **Documents** | Backblaze B2 = system of record (originals, text, manifests) | same |
| **Backups** | Nightly `pg_dump` → B2; weekly restore test | same, plus point-in-time |
| **Mac (M5 Air, 16 GB)** | Development, portal capture (human + bookmark), OCR, Qwen3-8B testing | Development only |

**Budget:** pilot **≈ ₹12–25k / month**. Scale on a subsidised H100 **≈ ₹75–90k / month** (flat, any volume).
ChatGPT's envelope of ₹30–70k for the first deployment is safe but higher than we need.

**Why this shape:**
- Generation is the only expensive part. At pilot volume, paying per question costs a fraction of an idle GPU.
- Every other part fits on one ordinary server we already know how to run.
- Changing the model later is one setting (`LLM_BASE_URL`), because our API already talks to any OpenAI-compatible server.

---

## 2. What we keep from the ChatGPT plan, and what we change

| ChatGPT plan | Decision | Reason |
|---|---|---|
| RAG first; no training on the PDFs | **Keep** | Already how we work. Fine-tuning comes later, from reviewed Q&A (PLAN §0 E–F), not raw PDFs. |
| B2 as the document system of record, checksums, immutable originals | **Keep** (already built) | `ingest:portal` stores the PDF + manifest in B2 with sha256 and evicts local routine PDFs only after verification. |
| Jev as a bounded decision layer, never the legal authority, rules as fallback | **Keep** | Matches our plan. Jev never writes an answer; if it is down, rules decide. |
| Citation validation; version stamp on every answer; audit log | **Keep** | Answer validation exists. We add model / retrieval / corpus versions to each stored answer. |
| 1,000-document benchmark before the full run | **Keep**, as the Ask quality pack (task 47): ~100 real questions + labelled orders | Measures what users feel: correct citations, speed, cost per 1,000 questions. |
| Dev / staging / prod separation, MFA for admins, private databases | **Keep** | Staging = a second Compose stack on the same VM with its own database. |
| **Qwen3-3B** on the Mac | **Change → Qwen3-8B (MLX), as now** | There is no Qwen3-3B. The 16 GB Mac runs 8B at 4-bit comfortably. |
| **Qwen3-32B** as the production model | **Change → test first** against **Qwen3.5 / 3.6-35B-A3B** (MoE, ~3B active) and **Qwen3.8-27B** | The MoE writes 5–8× faster on the same GPU at similar quality. 32B dense stays a candidate; the eval decides. |
| **OpenSearch + Qdrant** | **Change → Postgres** (full-text `tsvector` + `pgvector`, which we already run) | Two extra services to run, secure and back up, for a corpus Postgres handles. We add BM25 (`pg_search`) or a vector store only if the eval shows a recall problem. |
| **FastAPI** backend | **Change → keep our Fastify API + FastAPI retrieval service** | Rewriting a working API adds nothing. |
| **Vercel + Railway** | **Change → one VM + Cloudflare** (Vercel optional for the web only) | See the notes below. |
| PyMuPDF / OCRmyPDF, OCR only pages without text | **Keep the principle** | Already done: text layer first, garble detection, OCR only where needed. |

Notes on Vercel + Railway:
- The vectors need 8–16 GB of RAM. On usage-billed Railway that alone costs more than a whole VM.
- Answers stream through the web proxy, so splitting web and API across providers adds a hop and more places to fail.
- Vercel's free plan is non-commercial, so a company needs Pro.

---

## 3. How one question flows (target design)

```
Official asks (Hindi / English)
   │
   ▼
[0] Answer cache ─────────────── hit ──► instant answer (with the same citations)
   │ miss
   ▼
[1] Router: rules → Jev (typed choice)
   ├─ order list / GO number / date range ──► deterministic SQL listing (no LLM)
   ├─ not covered by our documents        ──► "not in our records" + portal link (no LLM)
   ├─ simple lookup                       ──► small model (Qwen3.5-9B / 4B)
   └─ explanation / comparison / drafting / procurement ──► main Qwen
   │
   ▼
[2] Retrieval (Postgres): full-text + vectors + department/date/tier filters
   → ~40 passages → Jev or Qwen3-Reranker keeps the best 5–8
   │
   ▼
[3] Qwen writes the answer from those passages only (streams to the user)
   │
   ▼
[4] Checks: numbers and dates validated in code; Jev "does this passage support
    this sentence?" per citation; failures trigger one repair pass
   │
   ▼
[5] Store: question, answer, passage IDs, model + corpus version, feedback
    → answer cache + learning data (reviewed before any reuse)
```

What each step saves:
- **Cache:** officials repeat questions (DA, leave, GeM limits, transfer policy). A cached answer costs nothing and returns instantly.
  - It is dropped automatically when a newer order supersedes any cited order (we already build "supersedes" links) or when the corpus version changes.
- **Router:** order lists and out-of-scope questions never reach a model. Simple lookups use a model 5–10× cheaper.
- **Passage ranking:** 5–8 passages instead of 24 means 2–3× shorter prompts, so each question is faster and cheaper.
- **Jev citation check:** replaces a second Qwen pass that costs about 10× more.

---

## 4. Work done once, at ingestion (cheap, in bulk)

Once, when an order arrives, with rules first, then Jev, then Qwen only where needed:
1. **Classify:** tier A/B/C, document type, topic codes, department. Jev handles bulk sorting (177k orders ≈ $10). Low confidence goes to a review queue.
2. **Order card:** a 3–5 line summary plus key facts (who it applies to, amounts, dates, what it amends or supersedes). Written by Qwen in night batches.
   - Ask reads cards first and opens full pages only when needed, which shrinks prompts 3–5×.
3. **Embed** chunks and subjects (Qwen3-Embedding, 1024-d, as now). Store them as `halfvec` to halve the RAM.
4. **Ready answers:** top ~50 questions per department, drafted from the cards and approved by a reviewer. These are the first cache entries and the first supervised learning data.

These jobs run on the pilot's model API, or on the GPU at night once we have one. A bulk run on spot GPUs costs a few hundred rupees.

---

## 5. Models

| Role | Pilot | Scale | Notes |
|---|---|---|---|
| Main answers | Qwen3.5/3.6-35B-A3B **or** Qwen3.8-27B via API (winner of the eval) | Same model on vLLM, FP8 | Qwen3-32B dense stays in the eval as the baseline |
| Simple lookups | Qwen3.5-9B / 4B via API | Same, on the same GPU | Chosen by the router |
| Decisions | Jev via OpenRouter (`jev-latest`) | same | Must pass our Hindi test first. Fallback: Qwen3-Reranker + rules |
| Embeddings | Qwen3-Embedding-0.6B (CPU) | GPU | Unchanged; changing it means re-embedding everything |
| Reranker | Qwen3-Reranker-0.6B (CPU) | GPU | Kept as the fallback for Jev |
| Mac | Qwen3-8B 4-bit (MLX) | — | Dev and offline tests |

**Jev's Hindi gate:** 200 labelled orders (tier + topic) and 50 question→passage pairs.
- If Jev matches or beats our rules plus Qwen3-Reranker, use it.
- If not, it stays off, and nothing else changes.
- Only the passage text and the question go to Jev, never user identities.

**vLLM settings at scale:**
- continuous batching
- automatic prefix caching (our system prompt and rules are reused on every question)
- FP8 weights
- speculative decoding with a small draft model or EAGLE-3, if vLLM supports it for the chosen model
- a hard `max_tokens` cap per route

One H100 with the MoE model serves a large office (dozens of concurrent answers).

---

## 6. Cost model

Assumptions:
- ~10k input and ~0.9k output tokens per full answer (measured, ROADMAP §9)
- 30% of questions served by the cache or a listing
- 40% of the rest go to the small model

| | Pilot: 100 users, ~22k questions / month | Launch: 1,000 users, ~200k questions / month |
|---|---|---|
| VM (8 vCPU / 32 GB) | ₹5–8k | ₹10–15k (16 vCPU / 64 GB) |
| Answer model | API: ₹3–10k | API: ₹30–80k **or** own GPU (below) |
| Jev | ₹500–1,500 | ₹4–10k |
| B2 (~100 GB for 177k orders; ~300 GB at 500k) | < ₹200 | < ₹500 |
| Cloudflare, domain, monitoring | ₹0–2k | ₹2–4k |
| **Total** | **≈ ₹12–25k** | **≈ ₹50–110k** (API) |

**Own GPU, when it pays:**

| Option | Hourly | 24×7 per month |
|---|---|---|
| IndiaAI Mission subsidised H100 | ≈ ₹92 | **≈ ₹67k** |
| Market H100 in India (E2E, JarvisLabs, Cyfuture) | ₹160–220 | ₹1.2–1.6 lakh |
| E2E spot H100 (can be interrupted; for batch jobs only) | ≈ ₹70 | — |

- **Switch to our own GPU when** the IndiaAI allocation is approved, **or** API spend passes ~₹60k/month (about 150k full answers), **or** a department requires dedicated hosting.
- With the subsidy, the launch total becomes **≈ ₹75–90k flat** with plenty of headroom.
- One-time bulk jobs (order cards, re-embedding, Jev sorting) cost **≈ ₹2–5k** in total.

---

## 7. IndiaAI compute: using the company

1. Get **DPIIT startup recognition** (Startup India portal) for your company. Check it lists AI / GovTech as its activity.
2. Apply on the **IndiaAI Compute Portal**. Describe the project as a *public-interest AI assistant for government functionaries, grounded in public Government Orders, Hindi-first*. Projects of national importance get priority.
3. Ask for an H100 (or L40S) allocation for inference, plus batch hours.
4. Meanwhile, run the pilot on the model API. Nothing in the app changes when the GPU arrives, only `LLM_BASE_URL`.

Approval isn't guaranteed. The plan works without it, just at market GPU prices later.

---

## 8. Security and operations

- Cloudflare in front. Only 443 open. Postgres, retrieval and the model server bind to the private network or localhost.
- Secrets stay in the server's environment files, never in the repository.
- Sign-in (PLAN §0 A6), roles (official / reviewer / admin), MFA for admins, and a rate limit per user and per IP.
- Nightly database dump to B2, a weekly restore test into staging, and B2 object lock on originals.
- Monitoring:
  - uptime and response-time checks
  - per-route token and cost counters in the API (dashboard in the admin console)
  - an alert when daily cost passes a set limit
- Daily sync runs on the VM (`sync:daily` via cron/systemd).
- Portal capture stays human-in-the-loop on the Mac: bookmark plus CAPTCHA by a person.
- Permanent rules from `docs/RULES.md` hold in production:
  - citations always show the official government URL
  - only government-domain sources are ingested
  - scope is central + UP
- Every stored answer records the model, prompt version, retrieval settings and corpus version.

---

## 9. Phases

| # | What | Exit check |
|---|---|---|
| 1 | Finish portal capture + downloads; order cards + Jev bulk sorting on a 1,000-order sample | Tier/topic accuracy measured against our overrides |
| 2 | Ask quality pack (100 questions, Hindi + English) and the eval harness `eval:rag` extended with cost and latency | Baseline numbers for today's setup |
| 3 | Model bake-off: 32B dense vs 35B-A3B vs 27B, each with and without Jev routing/ranking | Pick the winner on correct citations ≥ 90%, unsupported numbers ≤ 2%, median time, ₹ per 1,000 questions |
| 4 | Router + answer cache + order cards in the answer path | Same quality, ≥ 40% lower cost per question |
| 5 | VM + Cloudflare + Compose (prod + staging), backups, monitoring, sign-in | Closed pilot: 10–20 officials from 2–3 departments |
| 6 | IndiaAI application → own GPU (vLLM) when approved or when the cost trigger fires | Flat monthly cost; p95 answer time within target |
| 7 | Scale to 100 → 1,000 users; reviewed Q&A feeds the learning loop (PLAN §0 E) | Weekly failed-question review in place |

---

## 10. Decisions to lock now

1. RAG first; learning comes from reviewed Q&A, not from training on PDFs.
2. B2 is the document system of record; Postgres (with pgvector) is the only database.
3. One VM + Cloudflare for the pilot; the model through an API; our own GPU through IndiaAI when approved.
4. Main model chosen by the eval among Qwen3-32B, Qwen3.5/3.6-35B-A3B and Qwen3.8-27B; the model server stays swappable.
5. Jev is a helper for routing, ranking, citation checks and bulk sorting, behind a Hindi gate and with rules as fallback. It never writes an answer.
6. The Mac stays the development and capture machine.

## 11. What Abhishek needs to provide

- An OpenRouter account and key, with a spending limit, for Jev and the hosted Qwen models during the eval.
- DPIIT recognition for the company, then the IndiaAI compute application.
- A domain name and a Cloudflare account.
- The VM provider choice. Suggested: E2E Networks (Mumbai) to stay close to the IndiaAI GPU partners, or any Mumbai / Singapore host.

---

Sources:
- [Qwen 3.5–3.8 open-weights guide](https://codersera.com/blog/qwen-3-5-complete-guide-2026/)
- [Qwen3.6-35B-A3B](https://qwen.ai/blog?id=qwen3.6-35b-a3b)
- [What is Jev (Firecrawl)](https://www.firecrawl.dev/blog/what-is-jev)
- [Jev (Wikipedia)](https://en.wikipedia.org/wiki/Jev_(AI_model))
- [H100 prices in India and IndiaAI access](https://huggingface.co/blog/daya-shankar/nvidia-h100-price-india)
- [India GPU cloud pricing 2026](https://ecorpit.com/india-gpu-cloud-rental-pricing-h100-b200-2026/)
- [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing)
- ChatGPT, *Shasanadesh AI Optimized Architecture and Implementation Plan* (docx, 28 Sept 2026)
