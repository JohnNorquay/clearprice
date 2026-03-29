-- First add TIN column
ALTER TABLE providers ADD COLUMN IF NOT EXISTS tin TEXT;
CREATE INDEX IF NOT EXISTS idx_providers_tin ON providers(tin);

-- Drop old function (return type changed)
DROP FUNCTION IF EXISTS search_prices(TEXT, INTEGER, TEXT, INTEGER);

-- Recreate with TIN in return type
CREATE OR REPLACE FUNCTION search_prices(
  p_billing_code TEXT,
  p_plan_id INTEGER DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 500
)
RETURNS TABLE (
  procedure_name TEXT,
  billing_code TEXT,
  provider_name TEXT,
  provider_type TEXT,
  provider_taxonomy TEXT,
  provider_npi TEXT,
  provider_tin TEXT,
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
    pv.npi AS provider_npi,
    pv.tin AS provider_tin,
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
    AND r.negotiated_rate > 0
  ORDER BY r.negotiated_rate ASC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
