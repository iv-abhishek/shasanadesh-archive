-- ADR-066: conversations inactive for a month move to Archives automatically.
--   archived_at     when it was archived (manual or automatic)
--   archived_reason 'manual' (the person archived it) or 'inactive' (automatic)
--   restored_at     last time it was restored; counts as activity, so a restored
--                   conversation is not archived again straight away
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_reason TEXT,
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ;

UPDATE conversations
SET archived_at = updated_at,
    archived_reason = 'manual'
WHERE archived = TRUE
  AND archived_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_archived_reason_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_archived_reason_check
      CHECK (archived_reason IS NULL OR archived_reason IN ('manual', 'inactive'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversations_user_archived_idx
  ON conversations (user_id, archived_at DESC)
  WHERE archived = TRUE;
