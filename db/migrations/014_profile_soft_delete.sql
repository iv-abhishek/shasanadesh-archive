-- Profile delete (ADR-079): a deleted profile leaves the switcher at once and
-- frees its slot; it can be restored until purge_after, when the purge
-- deletes the row and everything that cascades from it (departments,
-- conversations, messages, sessions, feedback).

ALTER TABLE workspace_users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS workspace_users_purge_idx
  ON workspace_users (purge_after)
  WHERE deleted_at IS NOT NULL;
