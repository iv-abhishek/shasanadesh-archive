# PostgreSQL Data Model

## Core Identity

### Document

Logical key:

```text
source_id
```

For Shasanadesh this is the decoded four-part source ID.

### Logical Page

Logical key:

```text
(source_id, page_number)
```

This is the citation boundary.

### Page Variant

A logical page can have multiple text representations:

```text
native canonical
OCR canonical
OCR alternate
```

A selective OCR result is normally an **alternate**, not canonical.

### Chunk

Chunks belong to a page variant and always retain:

- source ID
- page number
- variant type
- canonical/alternate provenance

## Tables

### `documents`

Document/source metadata and capture metadata.

#### Grouping (ADR-064, migration 011)

The archive is not only Shasanadesh: it holds Central Government and Uttar Pradesh
documents (other states later) from any government source (Rulebook §2).

| Column | Meaning |
|---|---|
| `jurisdiction_code` | `IN` Government of India, `UP` Uttar Pradesh; a new state is one row in `jurisdictions` |
| `authority` | issuing ministry / department (central: issuer; UP: department) |
| `topics` | topic groups (`topics` table): procurement, gem, financial-rules, budget-accounts, service, pension, conduct-discipline, digital-it, rti, … |
| `status` | `current`, `superseded` (a later order supersedes/cancels it), `draft`, `historical` |
| `edition` | e.g. "Second Edition, 2025", "Updated up to 31 January 2026" |
| `provenance_ok` | Rulebook §2: false when the source is not a government host (flagged, excluded from answers) |
| `provider` | the collection it came from (`shasanadesh-up`, `core-rules`, `doe-gfr`, …) |

Hierarchy for browsing and filters: **jurisdiction → authority/department → topic →
document**, with tier (A/B/C), document type, status and date alongside.

### `pages`

One row per logical PDF page.

Important field:

- `numeric_conflict`: native/OCR variants disagree on extracted numeric tokens

### `page_variants`

Native/OCR page text.

### `chunks`

Retrieval chunks produced from a specific page variant.

The `embedding` column is intentionally dimensionless until an embedding model is
selected and evaluated. A later migration should enforce the selected dimension and
add the appropriate ANN index.

### `ingestion_runs`

Operational record of corpus loads/migrations.

## Retrieval Rule

Both canonical and alternate variants may participate in retrieval.

Before answer generation, results must be deduplicated by logical page:

```text
source_id + page_number
```

If a page has `numeric_conflict = true`, dates, amounts, rule numbers, GO numbers,
percentages, or other critical numeric claims must be verified against the original
source page or a stronger vision/manual verification stage.
