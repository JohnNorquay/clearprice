/**
 * ClearPrice - Provider Reference Resolver
 *
 * v2.0 schema puts provider_references at the root of in-network rate files.
 * This extracts the provider_references array and creates a lookup map:
 *   provider_group_id -> [{ npi, tin, business_name }]
 *
 * Then enriches rate CSV files by replacing ref:N with actual NPI/name/address
 * using the NPPES NPI Registry API.
 *
 * Usage:
 *   node resolve-providers.mjs <rate_file_url> [--limit N] [--output providers.json]
 *   node resolve-providers.mjs --enrich <rates.csv> <providers.json> [--output enriched.csv]
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { parser: makeParser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { pick } = require('stream-json/filters/Pick');
const { chain } = require('stream-chain');

import https from 'https';
import http from 'http';
import { createGunzip } from 'zlib';
import { readFileSync, writeFileSync } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

/**
 * Fetch a URL as a readable stream, following redirects.
 */
function fetchStream(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchStream(new URL(res.headers.location, url).href, maxRedirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const urlPath = new URL(url).pathname;
      const isGzip = res.headers['content-encoding'] === 'gzip' || urlPath.endsWith('.gz');
      resolve(isGzip ? res.pipe(createGunzip()) : res);
    }).on('error', reject);
  });
}

/**
 * Extract provider_references from a rate file.
 * Returns a Map of provider_group_id -> provider info.
 */
async function extractProviderReferences(fileUrl, { limit = Infinity } = {}) {
  console.log(`Extracting provider_references from: ${fileUrl.slice(0, 100)}...`);

  const stream = await fetchStream(fileUrl);

  const pipeline = chain([
    stream,
    makeParser(),
    pick({ filter: 'provider_references' }),
    streamArray(),
  ]);

  const providerMap = new Map();
  let count = 0;

  return new Promise((resolve, reject) => {
    pipeline.on('data', ({ value: ref }) => {
      count++;
      if (count % 1000 === 0) {
        process.stderr.write(`  Extracted ${count} provider references...\r`);
      }

      const id = ref.provider_group_id;
      const providers = [];

      for (const pg of (ref.provider_groups || [])) {
        const tinObj = pg.tin || {};
        const tin = typeof tinObj === 'object' ? (tinObj.value || '') : String(tinObj);
        const businessName = typeof tinObj === 'object' ? (tinObj.business_name || '') : '';

        for (const npi of (pg.npi || [])) {
          providers.push({
            npi: String(npi),
            tin,
            business_name: businessName,
          });
        }
      }

      providerMap.set(id, {
        provider_group_id: id,
        network_names: ref.network_name || [],
        providers: providers.slice(0, 50), // Cap per group to manage memory
        total_providers: providers.length,
      });

      if (count >= limit) {
        pipeline.destroy();
        console.log(`\n\nLimit reached at ${count} references.`);
        resolve(providerMap);
      }
    });

    pipeline.on('end', () => {
      console.log(`\n\nExtracted ${count} provider reference groups (${providerMap.size} unique IDs)`);
      resolve(providerMap);
    });

    pipeline.on('error', (err) => {
      console.error(`\nStream error: ${err.message}`);
      resolve(providerMap); // Return partial results
    });
  });
}

/**
 * Look up NPI details from the NPPES NPI Registry API.
 * Free, no auth, rate-limited to ~10 req/sec.
 */
async function lookupNPI(npi) {
  return new Promise((resolve, reject) => {
    const url = `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${npi}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.results && json.results.length > 0) {
            const r = json.results[0];
            const addr = r.addresses?.find(a => a.address_purpose === 'LOCATION') || r.addresses?.[0];
            resolve({
              npi,
              name: r.basic?.organization_name || `${r.basic?.first_name || ''} ${r.basic?.last_name || ''}`.trim(),
              type: r.enumeration_type === 'NPI-2' ? 'organization' : 'individual',
              taxonomy: r.taxonomies?.[0]?.desc || '',
              city: addr?.city || '',
              state: addr?.state || '',
              zip: addr?.postal_code?.slice(0, 5) || '',
              address: addr ? `${addr.address_1 || ''}, ${addr.city || ''}, ${addr.state || ''} ${addr.postal_code?.slice(0, 5) || ''}` : '',
            });
          } else {
            resolve({ npi, name: 'Unknown', type: 'unknown' });
          }
        } catch (e) {
          resolve({ npi, name: 'Error', type: 'error', error: e.message });
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Batch NPI lookups with rate limiting.
 */
async function batchLookupNPIs(npis, { concurrency = 5, delayMs = 200 } = {}) {
  const results = new Map();
  const unique = [...new Set(npis)];
  console.log(`\nLooking up ${unique.length} unique NPIs from NPPES registry...`);

  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const lookups = batch.map(npi => lookupNPI(npi));
    const batchResults = await Promise.all(lookups);
    for (const r of batchResults) {
      results.set(r.npi, r);
    }
    process.stderr.write(`  Looked up ${Math.min(i + concurrency, unique.length)}/${unique.length}\r`);
    if (i + concurrency < unique.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`\nNPI lookup complete. ${results.size} providers resolved.`);
  return results;
}

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
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
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

/**
 * Enrich a rates CSV by resolving ref:N to actual provider details.
 */
async function enrichRatesCSV(csvPath, providerMapPath, outputPath) {
  const providerData = JSON.parse(readFileSync(providerMapPath, 'utf8'));
  const providerMap = new Map(providerData.map(p => [p.provider_group_id, p]));

  // Collect all NPIs we need to look up
  const npis = new Set();
  for (const [, group] of providerMap) {
    for (const p of group.providers) {
      if (p.npi !== '0') npis.add(p.npi);
    }
  }

  // Look up NPIs
  const npiDetails = await batchLookupNPIs([...npis]);

  // Process CSV
  const rl = createInterface({ input: createReadStream(csvPath) });
  const lines = [];
  let headerWritten = false;

  for await (const line of rl) {
    if (!headerWritten) {
      lines.push(line + ',provider_name,provider_city,provider_state,provider_zip,provider_type');
      headerWritten = true;
      continue;
    }

    const cols = parseCSVLine(line);
    const npiCol = cols[8]; // provider_npi column

    // Helper to rebuild a CSV row from parsed fields
    const toCSV = (fields) => fields.map(f =>
      f.includes(',') || f.includes('"') ? `"${f.replace(/"/g, '""')}"` : f
    ).join(',');

    if (npiCol?.startsWith('ref:')) {
      const refId = parseInt(npiCol.slice(4));
      const group = providerMap.get(refId);
      if (group && group.providers.length > 0) {
        // Expand: one row per provider in the group (skip NPI 0)
        const realProviders = group.providers.filter(p => p.npi !== '0').slice(0, 20);
        for (const p of realProviders) {
          const detail = npiDetails.get(p.npi) || {};
          const newCols = [...cols];
          newCols[8] = p.npi;
          newCols[9] = p.tin;
          newCols.push(detail.name || p.business_name || '');
          newCols.push(detail.city || '');
          newCols.push(detail.state || '');
          newCols.push(detail.zip || '');
          newCols.push(detail.type || '');
          lines.push(toCSV(newCols));
        }
      } else {
        lines.push(line + ',Unknown,,,,');
      }
    } else {
      const detail = npiDetails.get(npiCol) || {};
      cols.push(detail.name || '');
      cols.push(detail.city || '');
      cols.push(detail.state || '');
      cols.push(detail.zip || '');
      cols.push(detail.type || '');
      lines.push(toCSV(cols));
    }
  }

  writeFileSync(outputPath || csvPath.replace('.csv', '-enriched.csv'), lines.join('\n'));
  console.log(`\nEnriched CSV written to ${outputPath || csvPath.replace('.csv', '-enriched.csv')}`);
  console.log(`${lines.length - 1} data rows`);
}

// CLI
const args = process.argv.slice(2);

if (args[0] === '--enrich') {
  // Enrich mode: resolve ref:N in CSV using provider map
  const csvPath = args[1];
  const providerMapPath = args[2];
  const outIdx = args.indexOf('--output');
  const outputPath = outIdx >= 0 ? args[outIdx + 1] : null;
  await enrichRatesCSV(csvPath, providerMapPath, outputPath);
} else if (args[0] === '--npi') {
  // Single NPI lookup test
  const result = await lookupNPI(args[1]);
  console.log(JSON.stringify(result, null, 2));
} else {
  // Extract provider_references from a rate file
  const fileUrl = args[0];
  if (!fileUrl) {
    console.log('Usage:');
    console.log('  node resolve-providers.mjs <rate_file_url> [--limit N] [--output providers.json]');
    console.log('  node resolve-providers.mjs --enrich <rates.csv> <providers.json> [--output enriched.csv]');
    console.log('  node resolve-providers.mjs --npi <npi_number>');
    process.exit(1);
  }

  const limIdx = args.indexOf('--limit');
  const limit = limIdx >= 0 ? parseInt(args[limIdx + 1]) : Infinity;
  const outIdx = args.indexOf('--output');
  const outputPath = outIdx >= 0 ? args[outIdx + 1] : '../data/parsed/provider-references.json';

  const providerMap = await extractProviderReferences(fileUrl, { limit });

  // Convert to JSON-serializable format
  const output = [...providerMap.values()];
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${output.length} provider reference groups to ${outputPath}`);

  // Show sample
  const sample = output.slice(0, 3);
  console.log('\nSample entries:');
  for (const s of sample) {
    console.log(`  ID ${s.provider_group_id}: ${s.total_providers} providers`);
    if (s.providers[0]) {
      console.log(`    First: NPI ${s.providers[0].npi}, ${s.providers[0].business_name || 'no name'}`);
    }
  }
}
