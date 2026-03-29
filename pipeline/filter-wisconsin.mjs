/**
 * ClearPrice - Wisconsin Provider Filter
 *
 * Takes a rates CSV with NPI columns and filters to only WI providers.
 * Uses batch NPI lookups against the NPPES registry.
 *
 * Usage: node filter-wisconsin.mjs <input.csv> [--output wi-rates.csv]
 */

import { createReadStream, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import https from 'https';

/**
 * Parse a CSV line respecting quoted fields.
 */
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

function toCSV(fields) {
  return fields.map(f => {
    const s = String(f ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

/**
 * Look up NPI from NPPES registry.
 */
function lookupNPI(npi) {
  return new Promise((resolve) => {
    const url = `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${npi}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.results?.length > 0) {
            const r = j.results[0];
            const addr = r.addresses?.find(a => a.address_purpose === 'LOCATION') || r.addresses?.[0];
            resolve({
              npi,
              name: r.basic?.organization_name || `${r.basic?.first_name || ''} ${r.basic?.last_name || ''}`.trim(),
              type: r.enumeration_type === 'NPI-2' ? 'organization' : 'individual',
              taxonomy: r.taxonomies?.[0]?.desc || '',
              city: addr?.city || '',
              state: addr?.state || '',
              zip: addr?.postal_code?.slice(0, 5) || '',
            });
          } else {
            resolve({ npi, state: '', name: 'Unknown' });
          }
        } catch { resolve({ npi, state: '', name: 'Error' }); }
      });
    }).on('error', () => resolve({ npi, state: '', name: 'Error' }));
  });
}

/**
 * Batch lookup NPIs with rate limiting.
 */
async function batchLookup(npis, { concurrency = 5, delayMs = 200 } = {}) {
  const results = new Map();
  const unique = [...new Set(npis)].filter(n => n && !n.startsWith('ref:') && n !== '0');
  console.log(`Looking up ${unique.length} unique NPIs...`);

  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const lookups = batch.map(npi => lookupNPI(npi));
    const batchResults = await Promise.all(lookups);
    for (const r of batchResults) results.set(r.npi, r);
    process.stderr.write(`  ${Math.min(i + concurrency, unique.length)}/${unique.length}\r`);
    if (i + concurrency < unique.length) await new Promise(r => setTimeout(r, delayMs));
  }

  console.log(`\nLookup complete. ${results.size} resolved.`);
  return results;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log('Usage: node filter-wisconsin.mjs <input.csv> [--output wi-rates.csv]');
    process.exit(1);
  }

  const outIdx = process.argv.indexOf('--output');
  const outputPath = outIdx >= 0 ? process.argv[outIdx + 1] : inputPath.replace('.csv', '-wi.csv');

  // Phase 1: Collect all unique NPIs
  const allNPIs = new Set();
  const rl1 = createInterface({ input: createReadStream(inputPath) });
  let isHeader = true;
  let npiColIdx = 8; // default

  for await (const line of rl1) {
    if (isHeader) {
      const cols = parseCSVLine(line);
      npiColIdx = cols.indexOf('provider_npi');
      if (npiColIdx === -1) npiColIdx = 8;
      isHeader = false;
      continue;
    }
    const cols = parseCSVLine(line);
    const npi = cols[npiColIdx];
    if (npi && !npi.startsWith('ref:') && npi !== '0') allNPIs.add(npi);
  }

  console.log(`Found ${allNPIs.size} unique NPIs in ${inputPath}`);

  // Phase 2: Look up all NPIs
  const npiMap = await batchLookup([...allNPIs]);

  // Count WI providers
  let wiCount = 0;
  for (const [, info] of npiMap) {
    if (info.state === 'WI') wiCount++;
  }
  console.log(`Wisconsin providers: ${wiCount} of ${npiMap.size}`);

  // Phase 3: Filter CSV to WI providers only, enriching with provider details
  const rl2 = createInterface({ input: createReadStream(inputPath) });
  const lines = [];
  let headerDone = false;
  let totalRows = 0;
  let wiRows = 0;

  for await (const line of rl2) {
    if (!headerDone) {
      lines.push(line + ',provider_name,provider_city,provider_state,provider_zip,provider_type,provider_taxonomy');
      headerDone = true;
      continue;
    }

    totalRows++;
    const cols = parseCSVLine(line);
    const npi = cols[npiColIdx];
    const info = npiMap.get(npi);

    if (info && info.state === 'WI') {
      cols.push(info.name, info.city, info.state, info.zip, info.type, info.taxonomy);
      lines.push(toCSV(cols));
      wiRows++;
    }
  }

  writeFileSync(outputPath, lines.join('\n') + '\n');
  console.log(`\nFiltered: ${wiRows} WI rows out of ${totalRows} total`);
  console.log(`Saved to ${outputPath}`);
}

main().catch(console.error);
