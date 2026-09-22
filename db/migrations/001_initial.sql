-- Shasanadesh Archive initial relational/retrieval schema.
--
-- Important:
-- - one logical document is identified by source_id
-- - one logical page is identified by (source_id, page_number)
-- - a logical page may have multiple text variants (native/OCR)
-- - OCR alternatives are retrieval aids, not automatically authoritative
-- - chunks inherit the provenance of their page variant

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS documents (
  source_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'shasanadesh-up',
  encoded_id TEXT,
  source_url TEXT NOT NULL,
  department TEXT,
  go_number TEXT,
  go_date DATE,
  sequence_number INTEGER,
  department_id INTEGER,
  section_id INTEGER,
  source_year INTEGER,
  verification_status TEXT,

  capture_downloaded_at TIMESTAMPTZ,
  capture_http_status INTEGER,
  capture_content_type TEXT,
  capture_bytes BIGINT,
  raw_sha256 TEXT,

  page_count INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_department_idx
  ON documents (department);

CREATE INDEX IF NOT EXISTS documents_year_idx
  ON documents (source_year);

CREATE INDEX IF NOT EXISTS documents_go_number_idx
  ON documents (go_number);

CREATE TABLE IF NOT EXISTS pages (
  source_id TEXT NOT NULL REFERENCES documents(source_id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL CHECK (page_number >= 1),

  -- Variant currently used by the canonical page corpus.
  canonical_variant TEXT NOT NULL CHECK (
    canonical_variant IN ('native', 'ocr')
  ),

  -- True when parallel native/OCR variants disagree on numeric tokens.
  -- This is a warning signal for dates, amounts, rule numbers, GO numbers, etc.
  numeric_conflict BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (source_id, page_number)
);

CREATE INDEX IF NOT EXISTS pages_numeric_conflict_idx
  ON pages (numeric_conflict)
  WHERE numeric_conflict = TRUE;

CREATE TABLE IF NOT EXISTS page_variants (
  variant_id TEXT PRIMARY KEY,

  source_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,

  variant_type TEXT NOT NULL CHECK (
    variant_type IN ('native', 'ocr')
  ),

  canonical BOOLEAN NOT NULL DEFAULT FALSE,
  text_content TEXT NOT NULL,
  chars INTEGER NOT NULL,
  numeric_tokens TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Kept nullable because not every extraction stage has been quality-scored.
  text_quality_score SMALLINT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  FOREIGN KEY (source_id, page_number)
    REFERENCES pages(source_id, page_number)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS page_variants_page_idx
  ON page_variants (source_id, page_number);

CREATE INDEX IF NOT EXISTS page_variants_canonical_idx
  ON page_variants (canonical);

-- PostgreSQL "simple" text search is intentionally used as a baseline.
-- Final retrieval will combine lexical search with embeddings and reranking.
CREATE INDEX IF NOT EXISTS page_variants_fts_idx
  ON page_variants
  USING GIN (to_tsvector('simple', text_content));

-- Useful for fuzzy matching through OCR noise.
CREATE INDEX IF NOT EXISTS page_variants_trgm_idx
  ON page_variants
  USING GIN (text_content gin_trgm_ops);

CREATE TABLE IF NOT EXISTS chunks (
  variant_chunk_id TEXT PRIMARY KEY,
  logical_page_id TEXT NOT NULL,

  source_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  variant_id TEXT NOT NULL REFERENCES page_variants(variant_id) ON DELETE CASCADE,

  variant_type TEXT NOT NULL CHECK (
    variant_type IN ('native', 'ocr')
  ),

  canonical BOOLEAN NOT NULL DEFAULT FALSE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 1),

  text_content TEXT NOT NULL,
  chars INTEGER NOT NULL,
  text_sha256 TEXT NOT NULL,

  -- Dimension is intentionally not fixed yet.
  -- Once the embedding model is selected and evaluated, we can enforce its
  -- dimension and create an ANN index in a later migration.
  embedding VECTOR,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  FOREIGN KEY (source_id, page_number)
    REFERENCES pages(source_id, page_number)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chunks_page_idx
  ON chunks (source_id, page_number);

CREATE INDEX IF NOT EXISTS chunks_variant_idx
  ON chunks (variant_id);

CREATE INDEX IF NOT EXISTS chunks_fts_idx
  ON chunks
  USING GIN (to_tsvector('simple', text_content));

CREATE INDEX IF NOT EXISTS chunks_trgm_idx
  ON chunks
  USING GIN (text_content gin_trgm_ops);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id BIGSERIAL PRIMARY KEY,
  stage TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  documents_processed INTEGER NOT NULL DEFAULT 0,
  pages_processed INTEGER NOT NULL DEFAULT 0,
  variants_processed INTEGER NOT NULL DEFAULT 0,
  chunks_processed INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
