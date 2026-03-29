/**
 * Backfill taxonomy (specialty) for all providers missing it.
 * Looks up each NPI in the NPPES registry and updates Supabase.
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import https from 'https';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function lookupNPI(npi) {
  return new Promise((resolve) => {
    https.get(`https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${npi}`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const r = j.results?.[0];
          if (r) resolve(r.taxonomies?.[0]?.desc || null);
          else resolve(null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function main() {
  // Get all providers missing taxonomy
  let offset = 0;
  let noTax = [];
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/providers?taxonomy=is.null&select=id,npi&limit=1000&offset=${offset}`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    const batch = await res.json();
    noTax = noTax.concat(batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log('Providers missing taxonomy:', noTax.length);

  let updated = 0;
  for (let i = 0; i < noTax.length; i += 5) {
    const batch = noTax.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (p) => {
      const tax = await lookupNPI(p.npi);
      return { npi: p.npi, taxonomy: tax };
    }));

    for (const r of results) {
      if (r.taxonomy) {
        await fetch(`${SUPABASE_URL}/rest/v1/providers?npi=eq.${r.npi}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ taxonomy: r.taxonomy }),
        });
        updated++;
      }
    }
    process.stderr.write(`  ${Math.min(i+5, noTax.length)}/${noTax.length} (${updated} updated)\r`);
    if (i + 5 < noTax.length) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\nDone. Updated ${updated} providers with taxonomy.`);
}

main().catch(console.error);
