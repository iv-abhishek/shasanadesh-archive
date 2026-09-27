-- Rulebook §2 (docs/RULES.md, ADR-063): only government sources.
-- provenance_ok is false when a document's source URL is not on a government
-- host, or the provenance audit (npm run sources:audit) flagged it. Flagged
-- documents stay stored (for review) but never reach answers or order search.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS provenance_ok BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS documents_provenance_flagged_idx
  ON documents (source_id)
  WHERE provenance_ok = FALSE;
