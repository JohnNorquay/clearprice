-- Enable RLS on all tables but allow public read access
-- ClearPrice data is all public (sourced from federally-mandated public files)

ALTER TABLE procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurers ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE in_network_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hospital_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE oon_allowed ENABLE ROW LEVEL SECURITY;

-- Public read access for all tables
CREATE POLICY "Public read procedures" ON procedures FOR SELECT USING (true);
CREATE POLICY "Public read insurers" ON insurers FOR SELECT USING (true);
CREATE POLICY "Public read plans" ON plans FOR SELECT USING (true);
CREATE POLICY "Public read providers" ON providers FOR SELECT USING (true);
CREATE POLICY "Public read in_network_rates" ON in_network_rates FOR SELECT USING (true);
CREATE POLICY "Public read hospital_prices" ON hospital_prices FOR SELECT USING (true);
CREATE POLICY "Public read oon_allowed" ON oon_allowed FOR SELECT USING (true);
