-- ClearPrice - Initial Schema
-- Wisconsin healthcare pricing transparency

-- Procedures: common medical procedures we track
CREATE TABLE procedures (
  id SERIAL PRIMARY KEY,
  billing_code TEXT NOT NULL,
  billing_code_type TEXT NOT NULL DEFAULT 'CPT',
  description TEXT NOT NULL,
  short_name TEXT, -- human-friendly name like "MRI Brain"
  category TEXT, -- imaging, lab, office_visit, surgery, maternity
  UNIQUE(billing_code, billing_code_type)
);

-- Insurers: health insurance companies
CREATE TABLE insurers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  short_name TEXT, -- "UHC", "Anthem", "Medica"
  toc_url TEXT,
  notes TEXT
);

-- Plans: specific insurance plans
CREATE TABLE plans (
  id SERIAL PRIMARY KEY,
  insurer_id INTEGER REFERENCES insurers(id),
  plan_name TEXT NOT NULL,
  plan_id TEXT, -- EIN or HIOS ID
  plan_id_type TEXT, -- 'EIN' or 'HIOS'
  market_type TEXT, -- 'group' or 'individual'
  UNIQUE(insurer_id, plan_name)
);

-- Providers: healthcare providers (hospitals, clinics, doctors)
CREATE TABLE providers (
  id SERIAL PRIMARY KEY,
  npi TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider_type TEXT, -- 'organization' or 'individual'
  taxonomy TEXT, -- specialty description
  city TEXT,
  state TEXT DEFAULT 'WI',
  zip TEXT,
  address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION
);

-- In-network rates: the core pricing data
CREATE TABLE in_network_rates (
  id BIGSERIAL PRIMARY KEY,
  procedure_id INTEGER REFERENCES procedures(id),
  provider_id INTEGER REFERENCES providers(id),
  plan_id INTEGER REFERENCES plans(id),
  negotiated_rate NUMERIC(12,2) NOT NULL,
  negotiated_type TEXT, -- 'negotiated', 'derived', 'fee schedule', 'percentage', 'per diem'
  billing_class TEXT, -- 'professional' or 'institutional'
  setting TEXT, -- 'inpatient', 'outpatient', 'both'
  expiration_date DATE,
  source_file TEXT, -- which MRF file this came from
  loaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Hospital cash prices: self-pay / cash pricing from hospital transparency files
CREATE TABLE hospital_prices (
  id BIGSERIAL PRIMARY KEY,
  procedure_id INTEGER REFERENCES procedures(id),
  provider_id INTEGER REFERENCES providers(id),
  gross_charge NUMERIC(12,2), -- sticker price
  cash_price NUMERIC(12,2), -- discounted self-pay price
  min_negotiated NUMERIC(12,2),
  max_negotiated NUMERIC(12,2),
  source_file TEXT,
  loaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Out-of-network allowed amounts
CREATE TABLE oon_allowed (
  id BIGSERIAL PRIMARY KEY,
  procedure_id INTEGER REFERENCES procedures(id),
  provider_id INTEGER REFERENCES providers(id),
  plan_id INTEGER REFERENCES plans(id),
  allowed_amount NUMERIC(12,2),
  billed_charge NUMERIC(12,2),
  billing_class TEXT,
  source_file TEXT,
  loaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast querying
CREATE INDEX idx_rates_procedure ON in_network_rates(procedure_id);
CREATE INDEX idx_rates_provider ON in_network_rates(provider_id);
CREATE INDEX idx_rates_plan ON in_network_rates(plan_id);
CREATE INDEX idx_rates_procedure_plan ON in_network_rates(procedure_id, plan_id);
CREATE INDEX idx_providers_state ON providers(state);
CREATE INDEX idx_providers_city ON providers(city);
CREATE INDEX idx_providers_zip ON providers(zip);
CREATE INDEX idx_hospital_procedure ON hospital_prices(procedure_id);

-- Seed procedures
INSERT INTO procedures (billing_code, billing_code_type, short_name, description, category) VALUES
  ('70553', 'CPT', 'MRI Brain (with & without contrast)', 'MRI brain w/o & w/dye', 'imaging'),
  ('70551', 'CPT', 'MRI Brain (without contrast)', 'MRI brain w/o dye', 'imaging'),
  ('73721', 'CPT', 'MRI Lower Joint', 'MRI joint lower extremity', 'imaging'),
  ('74177', 'CPT', 'CT Abdomen & Pelvis', 'CT abdomen & pelvis w/dye', 'imaging'),
  ('71260', 'CPT', 'CT Chest', 'CT chest w/dye', 'imaging'),
  ('77067', 'CPT', 'Screening Mammogram', 'Screening mammography', 'imaging'),
  ('80053', 'CPT', 'Comprehensive Metabolic Panel', 'Comprehensive metabolic panel', 'lab'),
  ('85025', 'CPT', 'CBC (Complete Blood Count)', 'Complete blood count (CBC)', 'lab'),
  ('81001', 'CPT', 'Urinalysis', 'Urinalysis', 'lab'),
  ('99213', 'CPT', 'Office Visit (Established, Level 3)', 'Office visit, established, level 3', 'office_visit'),
  ('99214', 'CPT', 'Office Visit (Established, Level 4)', 'Office visit, established, level 4', 'office_visit'),
  ('99203', 'CPT', 'Office Visit (New, Level 3)', 'Office visit, new, level 3', 'office_visit'),
  ('27447', 'CPT', 'Total Knee Replacement', 'Total knee arthroplasty', 'surgery'),
  ('29881', 'CPT', 'Knee Arthroscopy', 'Knee arthroscopy/surgery with meniscectomy', 'surgery'),
  ('43239', 'CPT', 'Upper GI Endoscopy with Biopsy', 'Esophagogastroduodenoscopy with biopsy', 'surgery'),
  ('45380', 'CPT', 'Colonoscopy with Biopsy', 'Colonoscopy with biopsy', 'surgery'),
  ('59400', 'CPT', 'Vaginal Delivery (Routine OB)', 'Routine OB care, vaginal delivery', 'maternity'),
  ('59510', 'CPT', 'C-Section (Routine OB)', 'Routine OB care, cesarean delivery', 'maternity');

-- Seed insurers
INSERT INTO insurers (name, short_name, notes) VALUES
  ('UnitedHealthcare', 'UHC', 'Blob API at transparency-in-coverage.uhc.com, schema v2.0'),
  ('Anthem/Elevance (BCBS)', 'Anthem', 'TOC on S3, WI files on anthembcbswi.mrf.bcbs.com'),
  ('Medica', 'Medica', 'HealthSparq hosted, schema v1.3.1, 3 WI plans');

-- Seed plans
INSERT INTO plans (insurer_id, plan_name, plan_id, plan_id_type, market_type) VALUES
  ((SELECT id FROM insurers WHERE short_name = 'Medica'), 'Medica Choice Passport-WI', '57637WI007', 'HIOS', 'group'),
  ((SELECT id FROM insurers WHERE short_name = 'Medica'), 'Medica CompleteHealth-WI', '57637WI011', 'HIOS', 'group'),
  ((SELECT id FROM insurers WHERE short_name = 'Medica'), 'Essentia Choice Care with Medica-WI', '57637WI012', 'HIOS', 'group');

-- RPC function: search for prices by procedure
CREATE OR REPLACE FUNCTION search_prices(
  p_billing_code TEXT,
  p_plan_id INTEGER DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  procedure_name TEXT,
  billing_code TEXT,
  provider_name TEXT,
  provider_type TEXT,
  provider_taxonomy TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  insurer_name TEXT,
  plan_name TEXT,
  negotiated_rate NUMERIC,
  billing_class TEXT,
  setting TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    pr.short_name AS procedure_name,
    pr.billing_code,
    pv.name AS provider_name,
    pv.provider_type,
    pv.taxonomy AS provider_taxonomy,
    pv.city,
    pv.state,
    pv.zip,
    i.name AS insurer_name,
    pl.plan_name,
    r.negotiated_rate,
    r.billing_class,
    r.setting
  FROM in_network_rates r
  JOIN procedures pr ON r.procedure_id = pr.id
  JOIN providers pv ON r.provider_id = pv.id
  JOIN plans pl ON r.plan_id = pl.id
  JOIN insurers i ON pl.insurer_id = i.id
  WHERE pr.billing_code = p_billing_code
    AND (p_plan_id IS NULL OR r.plan_id = p_plan_id)
    AND (p_city IS NULL OR LOWER(pv.city) = LOWER(p_city))
  ORDER BY r.negotiated_rate ASC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
