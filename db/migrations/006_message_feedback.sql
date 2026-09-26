-- Per-answer feedback (thumbs up / down with an optional reason and comment).
-- One row per assistant message; changing the vote updates it, clearing the
-- vote deletes it. Deleting a conversation removes its feedback.

CREATE TABLE IF NOT EXISTS message_feedback (
  message_id UUID PRIMARY KEY
    REFERENCES conversation_messages(id)
    ON DELETE CASCADE,
  user_id UUID NOT NULL
    REFERENCES workspace_users(id)
    ON DELETE CASCADE,
  rating TEXT NOT NULL
    CHECK (rating IN ('up', 'down')),
  reason TEXT,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS message_feedback_rating_idx
  ON message_feedback (rating, updated_at DESC);
