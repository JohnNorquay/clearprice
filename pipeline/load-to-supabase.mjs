/**
 * ClearPrice - Load parsed WI pricing data into Supabase
 *
 * Reads enriched WI-only CSV files and inserts into Supabase tables.
 *
 * Usage: node load-to-supabase.mjs <csv_file> --plan "Medica Choice Passport-WI"
 *
 * Requires: SUPABASE_URL and SUPABASE_SERVICE_KEY in .env
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { config } from 'dotenv';

config({ path: '../.env' });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

async function supabase(path, method = 'GET', body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation,resolution=merge-duplicates' : 'return=representation',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function main() {
  const csvPath = process.argv[2];
  const planIdx = process.argv.indexOf('--plan');
  const planName = planIdx >= 0 ? process.argv[planIdx + 1] : null;

  if (!csvPath || !planName) {
    console.log('Usage: node load-to-supabase.mjs <csv_file> --plan "Plan Name"');
    process.exit(1);
  }

  console.log(`Loading ${csvPath} for plan "${planName}"...`);

  // Get plan ID
  const plans = await supabase(`plans?plan_name=eq.${encodeURIComponent(planName)}`);
  if (!plans.length) {
    console.error(`Plan not found: ${planName}`);
    process.exit(1);
  }
  const planId = plans[0].id;
  console.log(`Plan ID: ${planId}`);

  // Get procedure lookup
  const procedures = await supabase('procedures');
  const procMap = new Map(procedures.map(p => [p.billing_code, p.id]));
  console.log(`Loaded ${procMap.size} procedures`);

  // Read CSV
  const rl = createInterface({ input: createReadStream(csvPath) });
  let header = null;
  const providerBatch = [];
  const rateBatch = [];
  let rowCount = 0;

  for await (const line of rl) {
    if (!header) {
      header = parseCSVLine(line);
      continue;
    }

    const cols = parseCSVLine(line);
    const row = {};
    header.forEach((h, i) => row[h] = cols[i]);

    const procedureId = procMap.get(row.billing_code);
    if (!procedureId) continue;

    const npi = row.provider_npi;
    if (!npi || npi.startsWith('ref:') || npi === '0') continue;

    // Queue provider upsert
    providerBatch.push({
      npi,
      name: row.provider_name || 'Unknown',
      provider_type: row.provider_type || null,
      taxonomy: row.provider_taxonomy || null,
      city: row.provider_city || null,
      state: row.provider_state || 'WI',
      zip: row.provider_zip || null,
      tin: row.provider_tin || null,
    });

    // Queue rate insert
    rateBatch.push({
      npi, // temporary, will resolve to provider_id
      procedure_id: procedureId,
      plan_id: planId,
      negotiated_rate: parseFloat(row.negotiated_rate) || 0,
      negotiated_type: row.negotiated_type || null,
      billing_class: row.billing_class || null,
      setting: row.setting || null,
      expiration_date: row.expiration_date === '9999-12-31' ? null : row.expiration_date || null,
      source_file: csvPath.split('/').pop(),
    });

    rowCount++;
  }

  console.log(`\nParsed ${rowCount} rows`);

  // Deduplicate providers
  const uniqueProviders = new Map();
  for (const p of providerBatch) {
    if (!uniqueProviders.has(p.npi)) uniqueProviders.set(p.npi, p);
  }

  // Upsert providers in batches
  const providerList = [...uniqueProviders.values()];
  console.log(`Upserting ${providerList.length} providers...`);
  for (let i = 0; i < providerList.length; i += 100) {
    const batch = providerList.slice(i, i + 100);
    await supabase('providers?on_conflict=npi', 'POST', batch);
    process.stderr.write(`  ${Math.min(i + 100, providerList.length)}/${providerList.length}\r`);
  }

  // Get provider ID lookup
  // Fetch all providers (paginate if needed)
  let allProviders = [];
  let offset = 0;
  while (true) {
    const batch = await supabase(`providers?select=id,npi&limit=1000&offset=${offset}`);
    allProviders = allProviders.concat(batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  const providerIdMap = new Map(allProviders.map(p => [p.npi, p.id]));
  console.log(`\nProvider ID map: ${providerIdMap.size} entries`);

  // Insert rates in batches
  const rateInserts = rateBatch
    .map(r => {
      const providerId = providerIdMap.get(r.npi);
      if (!providerId) return null;
      const { npi, ...rate } = r;
      return { ...rate, provider_id: providerId };
    })
    .filter(Boolean);

  console.log(`Inserting ${rateInserts.length} rates...`);
  for (let i = 0; i < rateInserts.length; i += 200) {
    const batch = rateInserts.slice(i, i + 200);
    await supabase('in_network_rates', 'POST', batch);
    process.stderr.write(`  ${Math.min(i + 200, rateInserts.length)}/${rateInserts.length}\r`);
  }

  console.log(`\n\nDone! Loaded ${rateInserts.length} rates for ${providerList.length} providers.`);
}

main().catch(console.error);
