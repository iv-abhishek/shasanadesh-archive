-- LGD (Local Government Directory) codes for a profile's state and district.
-- Names stay as entered/displayed; codes survive renames (Allahabad →
-- Prayagraj) and match other government systems. NULL when not in LGD
-- ("Central Government / Other").

ALTER TABLE workspace_users
  ADD COLUMN IF NOT EXISTS state_lgd_code INTEGER,
  ADD COLUMN IF NOT EXISTS district_lgd_code INTEGER;

CREATE INDEX IF NOT EXISTS workspace_users_district_lgd_idx
  ON workspace_users (district_lgd_code)
  WHERE district_lgd_code IS NOT NULL;
