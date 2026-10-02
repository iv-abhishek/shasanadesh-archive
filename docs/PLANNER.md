# Conversation planner (proposed ADR-076, step 3 of the MVP plan)

Status: **proposed, 2 Oct 2026** — to be accepted after the baseline eval and once answers are
written by a hosted model (Groq / OpenRouter), because the planner adds one model call per message.

## Why

How a message is understood is decided today by hand-written rules spread over six modules:
`intent-routing.ts` (greetings, explicit IDs, departments, "all departments"), `conversation.ts`
(follow-up words), `document-followup.ts` ("इस आदेश"), `order-listing.ts` (find/list orders:
dates, issuer, section, wildcards, fillers), `relevance.ts` and the department registry aliases.
Each new phrasing needs a new rule, and rules interact (2 Oct: adding the Handbook to the
rulebooks broke "seniority of medical officers"; "उत्तर प्रदेश शासन द्वारा जारी" became a
section name; "release by Ravi Ranjan" became search words). ChatGPT/Claude-like behaviour
means the model reads the message in the context of the conversation; the rules stay as a
fallback and as hard checks.

## Shape: bounded harness, not an open agent loop

```
message + recent turns + last answer's cited orders + profile
        │
        ▼
  1. PLANNER  (one model call, JSON only, ~1.5k tokens in / ~150 out)
        │   validated (schema) and corrected by deterministic checks
        ▼
  2. ROUTE + TOOLS  (code chooses, at most 2–3 steps)
        │   find_orders → listOrders   answer → retrieval(+filters) → writer
        │   order_content → order by number → writer
        │   later_changes → order links   chit_chat → fixed reply   clarify → ask back
        ▼
  3. WRITER   (existing prompt; evidence only)
        ▼
  4. VERIFIER (existing citation / numeric checks, repair, safe fallback)
        ▼
  5. TRACE    (plan, tools, evidence, model → done event + stored with the message)
```

## Planner output (validated with zod)

```json
{
  "intent": "answer | find_orders | order_content | later_changes | chit_chat | clarify",
  "standalone_question": "the question rewritten to stand alone, in the user's language",
  "language": "hi | en",
  "about_previous": "none | cited_orders | previous_topic",
  "department": "name as the user meant it, or null",
  "jurisdiction": "UP | IN | null",
  "go_number": "string or null",
  "date_text": "the date words as written (e.g. 'last week', '15.09.2023') or null",
  "section": "issuing section (अनुभाग) or null",
  "person_named": "a person given as issuer/signatory, or null",
  "search_terms": { "hi": ["सोलर पम्प", "अनुदान"], "en": ["solar pump", "subsidy"] },
  "clarify_question": "one short question when the message cannot be acted on, else null"
}
```

Inputs given to the planner: the last 4 user messages, the titles / departments / GO numbers of
the orders the last answer cited, the profile's departments, today's date, and the list of
department names (Hindi + English, ~96 lines). No order text — the planner never answers.

## Deterministic checks (rules that stay)

- GO numbers, quoted phrases and wildcard patterns are extracted by the existing parser and
  override the planner (exact matching must stay exact).
- `department` is resolved with the registry (`findDepartmentEntry`); unknown → ignored.
- `date_text` is parsed by `parseDateRange`; the planner never computes dates itself.
- A clicked suggestion keeps `followSourceIds` (answer from the cited orders only).
- Greetings / thanks still short-circuit before the planner (no model call).
- Validation of the written answer is unchanged.

## Fallback, cost, latency

- Planner timeout 3 s (hosted). Invalid JSON, timeout or no hosted model → today's rules.
  With only the local Mac model the planner is off (it would add 5–10 s).
- Cost per message ≈ 1.5k in + 150 out tokens: under ₹0.05 on OpenRouter; ~0.3–1 s.

## Rollout

1. `RAG_PLANNER=shadow`: run the planner on every message, log its plan next to the rules'
   decision, change nothing. Compare on the eval and on real conversations.
2. `RAG_PLANNER=on` once its decisions are at least as good: planner first, rules as fallback.
3. Remove rules that the planner makes redundant (follow-up word lists, filler lists) only
   after the 100-question quality pack passes without them.

## Done when

- The 2 Oct conversation's failures pass without new rules: "Solar pump up GO",
  "…उत्तर प्रदेश शासन द्वारा जारी…", "release by Ravi Ranjan", "it is solar pump subsidy order",
  "Agriculture, 15.09.2023", plus follow-ups without "this/इस".
- Eval pass rate ≥ baseline; median added latency ≤ 1 s.
