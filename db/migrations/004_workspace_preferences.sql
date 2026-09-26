-- Additional development profile details and persistent conversation pins.
-- Contact numbers are optional and are not used as an authentication factor.

ALTER TABLE workspace_users
  ADD COLUMN IF NOT EXISTS state_name TEXT,
  ADD COLUMN IF NOT EXISTS district TEXT,
  ADD COLUMN IF NOT EXISTS contact_number TEXT;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS conversations_user_pinned_updated_idx
  ON conversations (user_id, is_pinned DESC, updated_at DESC)
  WHERE archived = FALSE;
