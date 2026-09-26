-- Order classification (docs/ROADMAP.md §4, ADR-046).
-- doc_type / tier come from `npm run classify:orders` (rules + human overrides)
-- and are copied in by `npm run db:load`. They are retrieval settings, not
-- deletions: tier C ("routine or individual") is kept and browsable.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_type TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tier TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS classification JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_tier_check'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_tier_check CHECK (tier IS NULL OR tier IN ('A', 'B', 'C'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS documents_tier_idx ON documents (tier);
