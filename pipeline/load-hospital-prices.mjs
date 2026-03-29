/**
 * Load hospital cash prices into Supabase
 */
import { config } from 'dotenv';
config({ path: '../.env' });
import { readFileSync } from 'fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, method, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation,resolution=merge-duplicates' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`${res.status} ${t}`); }
  return res.json();
}

// Get procedure IDs
const procs = await sb('procedures?select=id,billing_code', 'GET');
const procMap = new Map(procs.map(p => [p.billing_code, p.id]));

// Upsert Froedtert as a provider
await sb('providers?on_conflict=npi', 'POST', [{
  npi: '1255334173',
  name: 'FROEDTERT HOSPITAL',
  provider_type: 'organization',
  taxonomy: 'General Acute Care Hospital',
  city: 'MILWAUKEE',
  state: 'WI',
  zip: '53226',
  tin: '396105970',
}]);

const provRes = await sb('providers?npi=eq.1255334173&select=id', 'GET');
const froedtertId = provRes[0].id;
console.log('Froedtert provider ID:', froedtertId);

// Load cash prices
const data = JSON.parse(readFileSync('../data/parsed/hospital-cash-prices.json', 'utf8'));
const inserts = [];
for (const r of data) {
  const procId = procMap.get(r.code);
  if (!procId) continue;
  inserts.push({
    procedure_id: procId,
    provider_id: froedtertId,
    gross_charge: r.gross_charge,
    cash_price: r.cash_price,
    source_file: 'froedtert-standardcharges.csv',
  });
}

// Dedupe by procedure_id (keep outpatient if both exist)
const byProc = new Map();
for (const r of inserts) {
  if (!byProc.has(r.procedure_id)) byProc.set(r.procedure_id, r);
}
const deduped = [...byProc.values()];

await sb('hospital_prices', 'POST', deduped);
console.log('Loaded', deduped.length, 'hospital cash prices for Froedtert');

// Show what we loaded
for (const r of deduped) {
  const proc = procs.find(p => p.id === r.procedure_id);
  console.log(`  CPT ${proc?.billing_code}: gross $${r.gross_charge} / cash $${r.cash_price}`);
}
