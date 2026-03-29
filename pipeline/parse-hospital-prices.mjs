/**
 * ClearPrice - Hospital Cash Price Parser
 *
 * Downloads hospital MRF files (via cms-hpt.txt discovery) and extracts
 * gross charges and cash/self-pay prices for our target CPT codes.
 *
 * Usage: node parse-hospital-prices.mjs [--hospital <url>] [--discover]
 */

import https from 'https';
import http from 'http';
import { createWriteStream, writeFileSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { Readable } from 'stream';

const TARGET_CODES = new Set([
  '70553', '70551', '73721', '74177', '71260', '77067',
  '80053', '85025', '81001',
  '99213', '99214', '99203',
  '27447', '29881', '43239', '45380', '59400', '59510',
]);

/**
 * Fetch URL as text, following redirects.
 */
function fetchText(url, maxBytes = 500000000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'ClearPrice/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).href, maxBytes));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        if (size > maxBytes) res.destroy();
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

/**
 * Fetch URL as a readable stream, following redirects.
 */
function fetchStream(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'ClearPrice/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchStream(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      resolve(res);
    }).on('error', reject);
  });
}

/**
 * Parse a CSV line respecting quotes.
 */
function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Parse a hospital MRF CSV file (CMS v2/v3 format) and extract cash prices.
 * The v3 format has a multi-row header:
 *   Row 1: hospital metadata header
 *   Row 2: hospital metadata values
 *   Row 3: column headers for rate data
 *   Row 4+: rate data
 */
async function parseHospitalCSV(csvUrl, hospitalName) {
  console.log(`  Downloading: ${csvUrl.slice(0, 100)}...`);

  const stream = await fetchStream(csvUrl);
  const rl = createInterface({ input: stream });

  let lineNum = 0;
  let header = null;
  let codeColIdx = -1;
  let codeTypeIdx = -1;
  let grossIdx = -1;
  let cashIdx = -1;
  let descIdx = -1;
  let settingIdx = -1;
  let billingClassIdx = -1;
  let payerIdx = -1;
  let planIdx = -1;
  let negDollarIdx = -1;

  const results = [];

  for await (const line of rl) {
    lineNum++;

    // Skip metadata rows — find the actual column header row
    if (!header) {
      const cols = parseCSVLine(line);
      // Look for the row that contains standard pricing columns
      const lower = cols.map(c => c.toLowerCase().trim());

      // v3 format: look for 'standard_charge|gross' or 'standard_charge|discounted_cash'
      const hasStdCharge = lower.some(c => c.includes('standard_charge'));
      // v2 format: look for 'gross_charge' or 'discounted_cash_price'
      const hasGross = lower.some(c => c.includes('gross'));

      if (hasStdCharge || (hasGross && lower.some(c => c.includes('cash') || c.includes('description')))) {
        header = lower;
        // Find column indexes
        codeColIdx = header.findIndex(c => c === 'code|1' || c === 'code' || c === 'cpt' || c === 'hcpcs_cpt' || c === 'procedure_code');
        codeTypeIdx = header.findIndex(c => c === 'code|1|type' || c === 'code_type');
        grossIdx = header.findIndex(c => c.includes('gross'));
        cashIdx = header.findIndex(c => c.includes('cash') || c.includes('discounted'));
        descIdx = header.findIndex(c => c === 'description' || c.includes('item_description'));
        settingIdx = header.findIndex(c => c === 'setting');
        billingClassIdx = header.findIndex(c => c.includes('billing_class'));
        payerIdx = header.findIndex(c => c.includes('payer_name'));
        planIdx = header.findIndex(c => c.includes('plan_name'));
        negDollarIdx = header.findIndex(c => c.includes('negotiated_dollar'));

        console.log(`  Header found at line ${lineNum}. Code col: ${codeColIdx}, Gross: ${grossIdx}, Cash: ${cashIdx}`);
        if (codeColIdx === -1) {
          console.log('  WARNING: Could not find code column. Headers:', header.slice(0, 10).join(', '));
        }
      }
      continue;
    }

    // Parse data row
    const cols = parseCSVLine(line);
    const code = codeColIdx >= 0 ? cols[codeColIdx]?.trim() : '';
    const codeType = codeTypeIdx >= 0 ? cols[codeTypeIdx]?.trim().toUpperCase() : '';

    // Only keep CPT/HCPCS codes we care about
    if (!TARGET_CODES.has(code)) continue;
    if (codeType && codeType !== 'CPT' && codeType !== 'HCPCS') continue;

    const gross = grossIdx >= 0 ? parseFloat(cols[grossIdx]) || null : null;
    const cash = cashIdx >= 0 ? parseFloat(cols[cashIdx]) || null : null;
    const desc = descIdx >= 0 ? cols[descIdx]?.trim() : '';
    const setting = settingIdx >= 0 ? cols[settingIdx]?.trim() : '';
    const billingClass = billingClassIdx >= 0 ? cols[billingClassIdx]?.trim() : '';
    const payer = payerIdx >= 0 ? cols[payerIdx]?.trim() : '';
    const plan = planIdx >= 0 ? cols[planIdx]?.trim() : '';
    const negDollar = negDollarIdx >= 0 ? parseFloat(cols[negDollarIdx]) || null : null;

    // We want the cash price row (not payer-specific rows)
    // In v3 format, each CPT has multiple rows: one per payer + cash + gross
    // Cash price row usually has no payer_name, or the cash field is populated

    if (cash && cash > 0) {
      results.push({
        hospital: hospitalName,
        code,
        description: desc,
        gross_charge: gross,
        cash_price: cash,
        setting,
        billing_class: billingClass,
      });
    }

    // Also capture negotiated rates per payer for comparison
    if (negDollar && negDollar > 0 && payer) {
      results.push({
        hospital: hospitalName,
        code,
        description: desc,
        gross_charge: gross,
        cash_price: null,
        negotiated_rate: negDollar,
        payer,
        plan,
        setting,
        billing_class: billingClass,
      });
    }
  }

  console.log(`  Parsed ${lineNum} lines, found ${results.length} matching rows`);
  return results;
}

/**
 * Discover hospital MRF URLs from cms-hpt.txt files.
 */
async function discoverHospitals(domains) {
  const hospitals = [];

  for (const domain of domains) {
    for (const path of ['/cms-hpt.txt', '/.well-known/cms-hpt.txt']) {
      try {
        const url = `https://${domain}${path}`;
        const text = await fetchText(url, 50000);
        if (text.includes('mrf-url')) {
          // Parse the txt file
          const lines = text.split('\n');
          let current = {};
          for (const line of lines) {
            if (line.startsWith('location-name:')) current.name = line.split(':').slice(1).join(':').trim();
            if (line.startsWith('mrf-url:')) current.url = line.split('mrf-url:')[1].trim();
            if (line.trim() === '' && current.url) {
              hospitals.push({ ...current, domain });
              current = {};
            }
          }
          if (current.url) hospitals.push({ ...current, domain });
          console.log(`Found ${hospitals.length} entries from ${domain}`);
          break;
        }
      } catch (e) {
        // Try next path
      }
    }
  }

  return hospitals;
}

// === Main ===
const args = process.argv.slice(2);

// Major WI health system domains
const WI_HOSPITAL_DOMAINS = [
  'www.froedtert.com',
  'www.uwhealth.org',
  'www.aurorahealthcare.org',
  'healthcare.ascension.org',
  'www.marshfieldclinic.org',
  'www.gundersenhealth.org',
  'www.ssmhealth.com',
  'www.thedacare.org',
  'www.mayoclinichealthsystem.org',
  'www.bellin.org',
  'www.mercyhealthsystem.org',
  'www.hshs.org',
  'www.prohealthcare.org',
  'www.aspirus.org',
];

console.log('ClearPrice - Hospital Cash Price Parser\n');

// Step 1: Discover hospital MRF URLs
console.log('Discovering hospital MRF files via cms-hpt.txt...');
const hospitals = await discoverHospitals(WI_HOSPITAL_DOMAINS);
console.log(`\nDiscovered ${hospitals.length} hospital MRF files\n`);

// Step 2: Parse each hospital file
const allResults = [];
for (const hosp of hospitals) {
  if (!hosp.url) continue;
  // Only parse CSV files (skip xlsx for now)
  if (hosp.url.endsWith('.xlsx') || hosp.url.endsWith('.xls')) {
    console.log(`Skipping ${hosp.name} (xlsx format)`);
    continue;
  }
  console.log(`\nParsing: ${hosp.name || hosp.domain}`);
  try {
    const results = await parseHospitalCSV(hosp.url, hosp.name || hosp.domain);
    allResults.push(...results);
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

// Step 3: Save results
console.log(`\n${'='.repeat(60)}`);
console.log(`Total results: ${allResults.length}`);

// Group by code for summary
const byCPT = {};
for (const r of allResults) {
  if (!byCPT[r.code]) byCPT[r.code] = { cash: [], gross: [] };
  if (r.cash_price) byCPT[r.code].cash.push(r);
}

console.log('\nCash prices found by procedure:');
for (const [code, data] of Object.entries(byCPT).sort()) {
  if (data.cash.length > 0) {
    const prices = data.cash.map(r => r.cash_price).sort((a, b) => a - b);
    console.log(`  CPT ${code}: ${data.cash.length} cash prices ($${prices[0]} - $${prices[prices.length - 1]})`);
  }
}

// Save to JSON
writeFileSync('../data/parsed/hospital-cash-prices.json', JSON.stringify(allResults, null, 2));
console.log(`\nSaved to data/parsed/hospital-cash-prices.json`);
