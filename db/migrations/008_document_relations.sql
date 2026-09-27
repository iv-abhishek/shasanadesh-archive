-- Links between orders (ADR-054): "order X amends / supersedes / cancels /
-- corrects / refers to order Y". Built by `npm run relations:build` from the
-- portal subject and native page text, copied in by `npm run db:load`.
-- source_id / target_source_id are plain text (no foreign key) because either
-- side may be an order that is listed but not yet archived. target_source_id
-- is NULL when the referenced order is not known yet; the number and date text
-- are always kept so a later load can resolve it.

CREATE TABLE IF NOT EXISTS document_relations (
  source_id TEXT NOT NULL,
  source_go_number TEXT,
  source_go_date DATE,
  kind TEXT NOT NULL CHECK (kind IN ('supersedes', 'amends', 'cancels', 'corrects', 'refers')),
  target_go_number TEXT NOT NULL,
  target_go_key TEXT NOT NULL,
  target_go_date DATE NOT NULL,
  target_source_id TEXT,
  found_in TEXT NOT NULL,
  evidence TEXT NOT NULL,
  PRIMARY KEY (source_id, target_go_key, target_go_date)
);

CREATE INDEX IF NOT EXISTS document_relations_target_key_idx
  ON document_relations (target_go_key, target_go_date);

CREATE INDEX IF NOT EXISTS document_relations_target_idx
  ON document_relations (target_source_id)
  WHERE target_source_id IS NOT NULL;
