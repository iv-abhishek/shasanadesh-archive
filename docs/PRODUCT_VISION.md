# Product Vision

**Status:** Working product direction, reviewed 2026-09-25  
**Companion docs:** [Product plan](PRODUCT_PLAN.md), [Architecture](ARCHITECTURE.md), [Workspace](WORKSPACE.md)

## Purpose

Build a dependable, bilingual research assistant for government orders and related
official guidance. Users should be able to find the governing source quickly, understand
what it says, and open the evidence behind the answer.

The product is not just a chatbot and not just a PDF dump. It combines a well-provenanced
public-document archive, useful department-aware search, and a conversational interface
that makes the source material easier to understand.

## Users and profile workflow

### Government officials

An official profile should support a person's name, designation, state, district, and one
or more active departments. Multiple departments are a normal case for senior officers.
Those departments set the default relevance scope for search; they do not grant access to
documents.

An official designation or department selected by a user is a profile claim, not proof of
employment. Any official-only capability must depend on a verified server-side identity
and authorization policy.

Phone number should be optional, private, and collected only if a defined feature needs
it. It must not act as an authentication factor unless a verified sign-in system is added.
The current development profile APIs are not safe for storing real contact details.

### Public users

Public access should work without forcing a government designation or phone number. A
public user can use a general profile or provide an optional department of interest,
state/district, and response-language preference to make results more relevant.

Choosing a public or official profile must not itself change document permissions.
Department preferences are search settings, not access-control rules.

### Proposed onboarding

1. Offer **General access** and **Government official** as separate profile paths.
2. For general access, keep personal fields optional and allow global search by default.
3. For officials, collect work context and support multiple departments; verify identity
   before enabling any role-based or confidential feature.
4. Explain that profile departments tune search results and can be changed per question.

Until production identity and authorization exist, keep the current profile experience
development-only and do not solicit real phone numbers.

## Knowledge scope

The long-term corpus includes:

- Uttar Pradesh Government Orders from Shasanadesh;
- orders and circulars from other official state and central government domains;
- rules, GFR material, guidelines, manuals, policies, and administrative advisories;
- relationships such as amendments, supersession, corrigenda, and references.

“All .gov.in sites” is a long-term coverage goal, not one safe generic crawl. Register each
source and implement a source-specific adapter using its published indexes, sitemaps, or
stable document pages. Record source ownership, domain, document types, jurisdiction,
collection method, and crawl limits. Respect site rules and rate limits; do not bypass
CAPTCHAs or turn identifier probing into bulk enumeration.

## Document and evidence rules

- Preserve original bytes and capture provenance. A capture records its source URL, time,
  response metadata, byte count, and SHA-256.
- Keep originals immutable and store extracted text, page images, OCR, and embeddings as
  separate derived artifacts.
- Preserve native and OCR text as distinct variants. OCR can improve readability while
  corrupting names, dates, order numbers, or amounts.
- Deduplicate identical content without discarding distinct source URLs or capture
  history.
- Store originals and metadata manifests in Backblaze B2 with stable capture keys. The
  current ingester uses the Native API, which validates SHA-1 during upload, checks the
  returned byte count/checksum, and records SHA-256 as the capture fingerprint. Derived
  page, OCR, and chunk artifacts remain local for now.
- Show the issuer, document type, issue/effective date, department, source URL, exact page,
  and any known amendment or supersession relationship with the evidence.

## Answer experience

The answer should start with a crisp response, cite material claims to exact pages, and
make it easy to inspect the underlying order. When asked, it should explain administrative
language in simpler terms and use a clearly labeled example.

When suggesting a precedent or possible governing order, show why it may be relevant and
surface known relationships and dates. Do not infer legal precedence from recency alone.
If sources conflict or the text is uncertain, show that uncertainty rather than silently
choosing one version. The original source remains authoritative.

## Current implementation

The repository already contains a working MVP foundation:

- local Shasanadesh known-ID ingestion and source metadata;
- page-level text processing with native/OCR variants;
- PostgreSQL and pgvector hybrid search with reranking;
- a TypeScript RAG API with citations, numeric-evidence checks, and SSE responses;
- a Next.js chat UI with source cards, development profiles, multiple departments, and
  saved conversations.

Important gaps remain: no reusable multi-site source registry/crawler, no production
identity or authorization, and no public-versus-official onboarding. The frontend is a
functioning MVP, not the finished official workflow.

## Closeable pilot

To finish a useful first release soon, close a bounded pilot rather than treating every
government domain as a launch blocker:

1. Make the Shasanadesh acquisition workflow auditable and resumable, including clear
   failure reporting and safe retry behavior.
2. Process the available corpus into page-level evidence and searchable variants.
3. Deliver a stable bilingual chat, retained history, multi-department scope, and exact
   source-page evidence.
4. Evaluate representative Hindi and English questions, including numeric/OCR conflicts.
5. Add one additional official source through the same source-adapter pattern after its
   access method and document types are inventoried.
6. Keep real official profiles and private contact details behind production identity and
   authorization before opening that workflow to real users.

After the pilot, add government sources adapter by adapter and build explicit document
relationship data. Corpus expansion can continue after the first release.
