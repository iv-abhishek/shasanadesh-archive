# Rulebook — permanent product rules

These rules bind every feature, script, prompt and future session. A change needs
Abhishek's explicit decision and an ADR. Code that enforces a rule points back here
("Rulebook §n").

## §1 The chat shows only government URLs

- Every link in Ask — citations, source cards, "Official copy", "Copy answer", later-
  change notices, order lists — points to the **issuing government site** (for UP
  orders, `shasanadesh.up.gov.in`), at the cited page where possible.
- The chat never shows or links our archive: no local URLs (`/api/rag/pdf`, `localhost`),
  no file paths, no B2 keys, no internal IDs. Nothing in the chat suggests that we hold
  a copy of the data.
- Enforcement: the API sends only government URLs (`officialOnly`), strips any other
  URL or archive path from answer text (`stripNonGovernmentLinks`,
  `src/lib/public-links.ts`); the prompt forbids addresses and IDs; the chat opens
  citations on the official site (no archived-PDF viewer). The internal archive console
  (Search page) is for the team and is not part of the chat.
- The archive (B2 and the local cache) is used for **modelling, retrieval, evaluation
  and Q&A improvement** only.

## §2 Only government sources are ingested

- A source is accepted only from a government host: `*.gov.in`, `*.nic.in`, `*.सरकार.भारत` (central
  ministries, every state such as `up.gov.in`, NIC and S3WaaS district sites), or a
  government body on another domain listed with a reason in
  `src/lib/government-hosts.ts` (e.g. CERT-In). Aggregators, blogs, law portals and
  document-sharing sites are **never** ingested, even for a document that is public;
  they may only be used to discover the official URL.
- Enforcement: the fetcher (`politeFetch`), every adapter download and redirect, and the
  core-rules catalogue validation refuse non-government hosts.
- Anything already stored from a non-government source is **flagged**
  (`npm run sources:audit` → `metadata.provenance`; `documents.provenance_ok = false`)
  and kept out of answers, order search and subject search until reviewed.

## §3 Scope

- Now: **Central Government and Uttar Pradesh**. Later: other states, each as its own
  jurisdiction, from their own government sites (§2 applies unchanged).

## §4 An answer not taken from an archived page is always labelled

- When no archived order or rule page answers a question, Ask may answer from the
  model's general knowledge (decided by Abhishek, 3 Oct 2026, ADR-083) — never silently.
- Such an answer is shown with a visible note ("Not found in the archived orders … check
  it against the current order"), a "General knowledge" badge, no citations, no
  "Validated" badge and no follow-up suggestions, and it lists the closest archived
  documents to check.
- Enforcement: `answerFromGeneralKnowledge` in `src/api/server.ts`
  (`done.generalKnowledge`), the note in `apps/web/components/chat-app.tsx`.
  `RAG_GENERAL_KNOWLEDGE=0` turns it off; it is never used with a local model.
