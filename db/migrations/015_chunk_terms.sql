-- Keyword search through an index (ADR-092).
--
-- Each chunk's words, parsed once and stored, with a GIN index. The keyword
-- half of hybrid search finds chunks holding any meaningful word of the
-- question through the index and ranks them from the stored words, instead of
-- re-parsing (or trigram-comparing) every chunk on every question.
-- A trigger keeps it in step with chunks; deleting a chunk deletes its row.

CREATE TABLE IF NOT EXISTS chunk_terms (
  variant_chunk_id TEXT PRIMARY KEY
    REFERENCES chunks (variant_chunk_id) ON DELETE CASCADE,
  terms TSVECTOR NOT NULL
);

CREATE OR REPLACE FUNCTION chunk_terms_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chunk_terms (variant_chunk_id, terms)
  VALUES (NEW.variant_chunk_id, to_tsvector('simple', NEW.text_content))
  ON CONFLICT (variant_chunk_id) DO UPDATE SET terms = EXCLUDED.terms;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS chunk_terms_insert ON chunks;
CREATE TRIGGER chunk_terms_insert
  AFTER INSERT ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunk_terms_sync();

DROP TRIGGER IF EXISTS chunk_terms_update ON chunks;
CREATE TRIGGER chunk_terms_update
  AFTER UPDATE OF text_content ON chunks
  FOR EACH ROW
  WHEN (OLD.text_content IS DISTINCT FROM NEW.text_content)
  EXECUTE FUNCTION chunk_terms_sync();

-- Backfill before building the index (faster than indexing row by row).
INSERT INTO chunk_terms (variant_chunk_id, terms)
SELECT variant_chunk_id, to_tsvector('simple', text_content)
FROM chunks
ON CONFLICT (variant_chunk_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS chunk_terms_idx
  ON chunk_terms
  USING GIN (terms);

ANALYZE chunk_terms;
