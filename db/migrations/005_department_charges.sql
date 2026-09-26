-- Officers can hold additional charge of departments beyond their substantive
-- posting (for example an IAS officer who is Principal Secretary of one
-- department and holds additional charge of two others). A profile may also
-- have no department at all.
--
-- additional_charge is descriptive profile data and a relevance preference;
-- like the rest of user_departments it is not authorization.

ALTER TABLE user_departments
  ADD COLUMN IF NOT EXISTS additional_charge BOOLEAN NOT NULL DEFAULT FALSE;
