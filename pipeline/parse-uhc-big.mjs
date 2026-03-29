/**
 * ClearPrice - Parse UHC Choice-Plus-POS (9.4 GB compressed)
 *
 * Two-pass approach:
 * Pass 1: Extract provider_references (comes first in file)
 * Pass 2: Extract in-network rates for target CPT codes
 *
 * Runs as a long background job (~30-60 min).
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
import { createWriteStream, writeFileSync } from 'fs';

const TARGET_CODES = new Set([
  '70553', '70551', '73721', '74177', '71260', '77067',
  '80053', '85025', '81001',
  '99213', '99214', '99203',
  '27447', '29881', '43239', '45380', '59400', '59510',
]);

const FILE_URL = 'https://mrfstorageprod.blob.core.windows.net/public-mrf/2026-03-01/2026-03-01_UnitedHealthcare-of-Wisconsin--Inc-_Insurer_Choice-Plus-POS_8_in-network-rates.json.gz?sv=2024-11-04&ss=b&srt=sco&sp=rwlitfx&se=2030-02-16T17:39:32Z&st=2026-02-16T09:24:32Z&spr=https&sig=1PcuH99nzLXbiaxh2perZSJub%2FTbVC5CB1wc9Y%2BaU7s%3D';

function fetchStream(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchStream(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const urlPath = new URL(url).pathname;
      resolve(urlPath.endsWith('.gz') ? res.pipe(createGunzip()) : res);
    }).on('error', reject);
  });
}

function escapeCsv(val) {
  const s = String(val ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

const startTime = Date.now();
function elapsed() { return ((Date.now() - startTime) / 1000 / 60).toFixed(1) + 'min'; }

// ===== PASS 1: Extract provider_references =====
console.log(`[${elapsed()}] PASS 1: Extracting provider_references...`);
console.log(`File: ${FILE_URL.slice(0, 80)}...`);

const stream1 = await fetchStream(FILE_URL);
const pipeline1 = chain([
  stream1,
  makeParser(),
  pick({ filter: 'provider_references' }),
  streamArray(),
]);

const providerMap = new Map();
let refCount = 0;

await new Promise((resolve) => {
  pipeline1.on('data', ({ value: ref }) => {
    refCount++;
    if (refCount % 10000 === 0) {
      process.stderr.write(`  [${elapsed()}] ${refCount} refs, map size ${providerMap.size}\r`);
    }

    const id = ref.provider_group_id;
    const providers = [];
    for (const pg of (ref.provider_groups || [])) {
      const tinObj = pg.tin || {};
      const tin = typeof tinObj === 'object' ? (tinObj.value || '') : String(tinObj);
      const bizName = typeof tinObj === 'object' ? (tinObj.business_name || '') : '';
      // Only keep first 5 NPIs per group to manage memory
      for (const npi of (pg.npi || []).slice(0, 5)) {
        providers.push({ npi: String(npi), tin, biz: bizName });
      }
    }
    providerMap.set(id, providers);
  });

  pipeline1.on('end', resolve);
  pipeline1.on('error', (err) => {
    console.log(`\n  [${elapsed()}] Pass 1 error: ${err.message} (continuing with ${providerMap.size} refs)`);
    resolve();
  });
});

console.log(`\n[${elapsed()}] Pass 1 complete: ${refCount} refs, ${providerMap.size} unique IDs`);

// ===== PASS 2: Extract in-network rates =====
console.log(`\n[${elapsed()}] PASS 2: Extracting rates for ${TARGET_CODES.size} CPT codes...`);

const stream2 = await fetchStream(FILE_URL);
const pipeline2 = chain([
  stream2,
  makeParser(),
  pick({ filter: 'in_network' }),
  streamArray(),
]);

const out = createWriteStream('../data/parsed/uhc-choice-plus-pos.csv');
out.write('billing_code_type,billing_code,description,negotiated_type,negotiated_rate,billing_class,setting,expiration_date,provider_npi,provider_tin,negotiation_arrangement\n');

let scanned = 0, matched = 0, rows = 0;

await new Promise((resolve) => {
  pipeline2.on('data', ({ value: item }) => {
    scanned++;
    if (scanned % 10000 === 0) {
      process.stderr.write(`  [${elapsed()}] Scanned ${scanned}, matched ${matched}, rows ${rows}\r`);
    }

    const code = String(item.billing_code || '');
    if (!TARGET_CODES.has(code)) return;
    matched++;

    const codeType = item.billing_code_type || '';
    const description = item.description || '';
    const arrangement = item.negotiation_arrangement || '';

    for (const rg of (item.negotiated_rates || [])) {
      const providers = [];

      // Inline provider_groups
      for (const pg of (rg.provider_groups || [])) {
        const tin = typeof pg.tin === 'object' ? (pg.tin?.value || '') : String(pg.tin || '');
        for (const npi of (pg.npi || [])) providers.push([String(npi), tin]);
      }

      // Resolve provider_references
      if (providers.length === 0 && rg.provider_references) {
        for (const refId of rg.provider_references) {
          const refProviders = providerMap.get(refId);
          if (refProviders) {
            for (const p of refProviders) {
              providers.push([p.npi, p.tin]);
            }
          }
        }
      }

      for (const price of (rg.negotiated_prices || [])) {
        for (const [npi, tin] of providers) {
          out.write([
            codeType, code, escapeCsv(description),
            price.negotiated_type || '', price.negotiated_rate ?? '',
            price.billing_class || '', price.setting || '',
            price.expiration_date || '', npi, tin, arrangement,
          ].join(',') + '\n');
          rows++;
        }
      }
    }
  });

  pipeline2.on('end', () => {
    out.end();
    resolve();
  });

  pipeline2.on('error', (err) => {
    console.log(`\n  [${elapsed()}] Pass 2 error: ${err.message}`);
    out.end();
    resolve();
  });
});

console.log(`\n[${elapsed()}] COMPLETE`);
console.log(`  Items scanned: ${scanned}`);
console.log(`  Items matched: ${matched}`);
console.log(`  Rows written: ${rows}`);
console.log(`  Output: data/parsed/uhc-choice-plus-pos.csv`);
