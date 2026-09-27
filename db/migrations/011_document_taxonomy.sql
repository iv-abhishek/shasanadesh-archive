-- Grouping beyond Shasanadesh (ADR-064): every document belongs to a
-- jurisdiction (the Central Government "IN", Uttar Pradesh "UP"; other states
-- later, one row each), has an issuing authority, topic groups, a status and
-- an edition. Filled by `npm run db:load` from metadata, the core-rules
-- catalogue, the topic rules (src/classify/topics.ts) and order links.

CREATE TABLE IF NOT EXISTS jurisdictions (
  code TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('central', 'state')),
  name_en TEXT NOT NULL,
  name_hi TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO jurisdictions (code, level, name_en, name_hi) VALUES
  ('IN', 'central', 'Government of India', 'भारत सरकार'),
  ('UP', 'state', 'Uttar Pradesh', 'उत्तर प्रदेश')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS topics (
  code TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_hi TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100
);

INSERT INTO topics (code, name_en, name_hi, sort_order) VALUES
  ('procurement', 'Procurement', 'क्रय एवं अधिप्राप्ति', 10),
  ('gem', 'GeM', 'जेम (GeM)', 11),
  ('financial-rules', 'Financial rules and powers', 'वित्तीय नियम एवं अधिकार', 20),
  ('budget-accounts', 'Budget, sanctions and accounts', 'बजट, स्वीकृतियाँ एवं लेखा', 21),
  ('audit', 'Audit', 'लेखा परीक्षा', 22),
  ('service', 'Service and personnel', 'सेवा एवं कार्मिक', 30),
  ('pay-allowances', 'Pay and allowances', 'वेतन एवं भत्ते', 31),
  ('pension', 'Pension and retirement', 'पेंशन एवं सेवानिवृत्ति', 32),
  ('conduct-discipline', 'Conduct and discipline', 'आचरण एवं अनुशासन', 33),
  ('vigilance', 'Vigilance', 'सतर्कता', 34),
  ('digital-it', 'Digital and IT', 'डिजिटल एवं आईटी', 40),
  ('data-protection', 'Data protection and open data', 'डेटा संरक्षण एवं ओपन डेटा', 41),
  ('cybersecurity', 'Cybersecurity', 'साइबर सुरक्षा', 42),
  ('rti', 'Right to Information', 'सूचना का अधिकार', 50),
  ('records-office', 'Records and office procedure', 'अभिलेख एवं कार्यालय पद्धति', 51),
  ('grievances', 'Public grievances', 'जन शिकायत', 52),
  ('accessibility', 'Accessibility and disability', 'सुगम्यता एवं दिव्यांगजन', 53),
  ('schemes', 'Schemes', 'योजनाएँ', 60),
  ('works', 'Works and infrastructure', 'निर्माण कार्य', 61),
  ('land-revenue', 'Land and revenue', 'भूमि एवं राजस्व', 62),
  ('education', 'Education', 'शिक्षा', 63),
  ('health', 'Health', 'स्वास्थ्य', 64),
  ('agriculture', 'Agriculture', 'कृषि', 65),
  ('law-order', 'Home, police and prisons', 'गृह, पुलिस एवं कारागार', 66)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS jurisdiction_code TEXT REFERENCES jurisdictions(code);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS authority TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS topics TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'current';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS edition TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_status_check') THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_status_check CHECK (status IN ('current', 'superseded', 'draft', 'historical'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS documents_jurisdiction_idx ON documents (jurisdiction_code);
CREATE INDEX IF NOT EXISTS documents_topics_idx ON documents USING GIN (topics);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status) WHERE status <> 'current';
