-- Development cookie-backed workspace sessions.
--
-- The browser receives only an opaque random token. PostgreSQL stores only a
-- SHA-256 hash of that token. The durable user/profile/history data remains in
-- the existing workspace tables.
--
-- This is development identity continuity, not production authentication.

CREATE TABLE IF NOT EXISTS workspace_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL
    REFERENCES workspace_users(id)
    ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS workspace_sessions_user_active_idx
  ON workspace_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_sessions_expiry_idx
  ON workspace_sessions (expires_at);
