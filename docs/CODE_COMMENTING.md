# Code Commenting Convention

Comments should explain **why**, invariants, source-system quirks, and safety
boundaries. Avoid comments that simply restate obvious syntax.

Recommended file header:

```ts
/**
 * Pipeline stage: <stage>
 *
 * Purpose:
 *   <what this file is responsible for>
 *
 * Important invariants:
 *   - preserve original source provenance
 *   - do not silently discard extraction variants
 *   - keep page numbers stable for citations
 *
 * See:
 *   docs/PROJECT_MEMORY.md
 *   docs/ARCHITECTURE.md
 */
```

Use inline comments for:

- Shasanadesh-specific behavior
- Unicode/Hindi normalization decisions
- hashing semantics
- OCR/native selection logic
- retry/rate-limit decisions
- citation/page invariants
- database transaction boundaries
- non-obvious model/retrieval parameters

When a parameter affects retrieval/OCR/model quality, prefer a named constant or
environment variable and document the reason for the default.
