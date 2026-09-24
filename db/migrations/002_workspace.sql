-- Persistent user/workspace and conversation foundation.
--
-- This schema intentionally separates:
--   1. user profile / working departments
--   2. conversation history
--   3. per-conversation state
--
-- Department preferences are NOT authorization. Future production auth/access
-- control must be enforced independently.

CREATE TABLE IF NOT EXISTS departments (
  id BIGSERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bootstrap currently-known departments from the document corpus.
INSERT INTO departments (canonical_name)
SELECT DISTINCT TRIM(department)
FROM documents
WHERE department IS NOT NULL
  AND TRIM(department) <> ''
ON CONFLICT (canonical_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  designation TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en'
    CHECK (preferred_language IN ('en', 'hi')),
  default_scope TEXT NOT NULL DEFAULT 'my_departments'
    CHECK (default_scope IN ('my_departments', 'all_departments')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_departments (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL
    REFERENCES workspace_users(id)
    ON DELETE CASCADE,
  department_id BIGINT NOT NULL
    REFERENCES departments(id)
    ON DELETE RESTRICT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_departments_user_active_idx
  ON user_departments (user_id, valid_to);

CREATE INDEX IF NOT EXISTS user_departments_department_active_idx
  ON user_departments (department_id, valid_to);

CREATE UNIQUE INDEX IF NOT EXISTS user_departments_one_primary_active_idx
  ON user_departments (user_id)
  WHERE is_primary = TRUE
    AND valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_departments_unique_active_idx
  ON user_departments (user_id, department_id)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL
    REFERENCES workspace_users(id)
    ON DELETE CASCADE,
  title TEXT NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON conversations (user_id, updated_at DESC)
  WHERE archived = FALSE;

CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL
    REFERENCES conversations(id)
    ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversation_messages_conversation_idx
  ON conversation_messages (conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS conversation_state (
  conversation_id UUID PRIMARY KEY
    REFERENCES conversations(id)
    ON DELETE CASCADE,
  active_source_id TEXT,
  active_department TEXT,
  topic_summary TEXT,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
