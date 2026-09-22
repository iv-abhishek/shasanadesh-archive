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
