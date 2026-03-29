/**
 * Parse Anthem WI rate file (prefix 471).
 * Needs special handling because CloudFront signed URLs contain ~ characters
 * that get mangled by shell quoting.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { parser: makeParser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { pick } = require('stream-json/filters/Pick');
const { chain } = require('stream-chain');

import https from 'https';
import { createGunzip } from 'zlib';
import { createWriteStream } from 'fs';

const TARGET_CODES = new Set([
  '70553', '70551', '73721', '74177', '71260', '77067',
  '80053', '85025', '81001',
  '99213', '99214', '99203',
  '27447', '29881', '43239', '45380', '59400', '59510',
]);

// The URL with ~ chars preserved (not passed through shell)
const ANTHEM_WI_471_URL = 'https://anthembcbswi.mrf.bcbs.com/2026-03_471_12B0_in-network-rates.json.gz?&Expires=1776952883&Signature=rS02WuoYNsUMhJK3dgnKnxysnpWrp6Zci8ajx0J7L0X8Qtz41cyxhm9CvloJXYueUhfq8LjZFT2nxy4GdT1vKBCubfY5Sjz6BQOgkyHCMKixhcCnOcKnoDCCqDTbqCWngC9dvjn77fD6taxg2kX2uWdpnDlow1B~bGb0hyE0QKaww~Xvx7a9anQ7FOIsSeoV6ucf5VR1cLrhrqqtDltbniWtD3cfdkDqKpRjO0b8EN8IvYZcFZ2hSaCK2chggCiWPIXENSi8bJTdqcJzGEq~AHFqg-TXKlC-9cN8zEzszqgoi6NQCOdanolPTzRybE0waCx2wrZSUBe0dpAxZUtlVg__&Key-Pair-Id=K27TQMT39R1C8A';

function escapeCsv(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

console.log('Fetching Anthem WI 471 file...');
console.log('URL:', ANTHEM_WI_471_URL.slice(0, 80) + '...');

const req = https.get(ANTHEM_WI_471_URL, (res) => {
  console.log('HTTP Status:', res.statusCode);
  if (res.statusCode !== 200) {
    console.error('Failed. Headers:', JSON.stringify(res.headers));
    process.exit(1);
  }

  const gunzip = createGunzip();
  const pipeline = chain([
    res.pipe(gunzip),
    makeParser(),
    pick({ filter: 'in_network' }),
    streamArray(),
  ]);

  const out = createWriteStream('../data/parsed/anthem-wi-471.csv');
  out.write('billing_code_type,billing_code,description,negotiated_type,negotiated_rate,billing_class,setting,expiration_date,provider_npi,provider_tin,negotiation_arrangement\n');

  let scanned = 0, matched = 0, rows = 0;
  const LIMIT = 500;

  pipeline.on('data', ({ value: item }) => {
    scanned++;
    if (scanned % 5000 === 0) process.stderr.write(`  Scanned ${scanned}, matched ${matched}, rows ${rows}\r`);

    const code = String(item.billing_code || '');
    if (!TARGET_CODES.has(code)) return;
    matched++;

    const codeType = item.billing_code_type || '';
    const description = item.description || '';
    const arrangement = item.negotiation_arrangement || '';

    for (const rg of (item.negotiated_rates || [])) {
      const providers = [];
      for (const pg of (rg.provider_groups || [])) {
        const tin = typeof pg.tin === 'object' ? (pg.tin?.value || '') : String(pg.tin || '');
        for (const npi of (pg.npi || [])) providers.push([String(npi), tin]);
      }
      if (!providers.length && rg.provider_references) {
        for (const ref of rg.provider_references.slice(0, 10)) providers.push([`ref:${ref}`, '']);
      }
      for (const price of (rg.negotiated_prices || [])) {
        for (const [npi, tin] of providers) {
          out.write([codeType, code, escapeCsv(description),
            price.negotiated_type || '', price.negotiated_rate ?? '',
            price.billing_class || '', price.setting || '',
            price.expiration_date || '', npi, tin, arrangement].join(',') + '\n');
          rows++;
          if (rows >= LIMIT) {
            pipeline.destroy();
            out.end();
            console.log(`\n\nLimit ${LIMIT}. Scanned ${scanned}, matched ${matched}, rows ${rows}`);
            return;
          }
        }
      }
    }
  });

  pipeline.on('end', () => {
    out.end();
    console.log(`\n\nComplete: ${scanned} items, ${matched} matched, ${rows} rows`);
  });

  pipeline.on('error', (err) => {
    out.end();
    console.log(`\n\nError at ${scanned} items: ${err.message}. Wrote ${rows} rows.`);
  });
});

req.on('error', (err) => console.error('Request error:', err.message));
