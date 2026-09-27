-- Meaning-based order finding (ADR-058). One vector per order for its subject,
-- department, section and category, so "farmer registry" finds
-- "फार्मर रजिस्ट्री" across languages, including routine (tier C) orders that
-- have no text chunks. Built by `npm run embed:subjects` (incremental by
-- input hash); searched by the retrieval service's /subjects/search.

CREATE TABLE IF NOT EXISTS document_subject_embeddings (
  source_id TEXT PRIMARY KEY REFERENCES documents(source_id) ON DELETE CASCADE,
  input_sha256 TEXT NOT NULL,
  embedding vector(1024) NOT NULL,
  embedding_model TEXT NOT NULL,
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS document_subject_embeddings_hnsw_idx
  ON document_subject_embeddings
  USING hnsw (embedding vector_cosine_ops);
