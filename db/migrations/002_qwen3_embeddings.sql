-- Pilot embedding configuration:
--   Qwen/Qwen3-Embedding-0.6B
--   full output dimension: 1024
--
-- Qwen3-Embedding supports Matryoshka/custom dimensions, but we intentionally
-- start at the full 1024 dimensions so our first retrieval evaluation is not
-- confounded by dimensionality reduction.

ALTER TABLE chunks
  ALTER COLUMN embedding TYPE vector(1024)
  USING embedding::vector(1024);

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER,
  ADD COLUMN IF NOT EXISTS embedding_input_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
