/**
 * ClearPrice - Table of Contents Streaming Parser
 *
 * Streams an insurer's TOC file and extracts file URLs.
 * TOC files are the entry point — they tell us where the actual rate files live.
 *
 * Usage: node stream-toc.mjs <toc_url> [--all | --wi]
 */

import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray.js';
import { chain } from 'stream-json/chains/Chain.js';
import https from 'https';
import http from 'http';
import { createGunzip } from 'zlib';
import { createWriteStream, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';

// Common procedures people price-shop for
export const TARGET_CPT_CODES = {
  // Imaging
  '70553': 'MRI brain w/o & w/dye',
  '70551': 'MRI brain w/o dye',
  '73721': 'MRI joint lower extremity',
  '74177': 'CT abdomen & pelvis w/dye',
  '71260': 'CT chest w/dye',
  '77067': 'Screening mammography',
  // Labs
  '80053': 'Comprehensive metabolic panel',
  '85025': 'Complete blood count (CBC)',
  '81001': 'Urinalysis',
  // Office visits
  '99213': 'Office visit, established, level 3',
  '99214': 'Office visit, established, level 4',
  '99203': 'Office visit, new, level 3',
  // Procedures
  '27447': 'Total knee replacement',
  '29881': 'Knee arthroscopy/surgery',
  '43239': 'Upper GI endoscopy with biopsy',
  '45380': 'Colonoscopy with biopsy',
  '59400': 'Routine OB care (vaginal delivery)',
  '59510': 'Routine OB care (cesarean delivery)',
};

/**
 * Fetch a URL as a readable stream, following redirects and handling gzip.
 */
function fetchStream(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchStream(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const isGzip = res.headers['content-encoding'] === 'gzip' || url.endsWith('.gz');
      resolve(isGzip ? res.pipe(createGunzip()) : res);
    }).on('error', reject);
  });
}

/**
 * Stream a TOC JSON file incrementally.
 *
 * The TOC structure is:
 * { reporting_structure: [ { reporting_plans: [...], in_network_files: [...], allowed_amount_file: {...} } ] }
 *
 * We use stream-json to parse the top-level reporting_structure array incrementally.
 */
async function streamTOC(tocUrl, { filterWI = true, limit = Infinity } = {}) {
  console.log(`\nStreaming TOC: ${tocUrl}`);
  console.log(`Filter: ${filterWI ? 'Wisconsin only' : 'All plans'}\n`);

  const stream = await fetchStream(tocUrl);

  // We need to parse reporting_structure array items
  // stream-json's pick + streamArray handles this
  const { pick } = await import('stream-json/filters/Pick.js');

  const jsonStream = chain([
    stream,
    parser(),
    pick({ filter: 'reporting_structure' }),
    streamArray(),
  ]);

  const results = [];
  let scanned = 0;

  for await (const { value: structure } of jsonStream) {
    scanned++;
    if (scanned % 100 === 0) {
      process.stderr.write(`  Scanned ${scanned} structures...\r`);
    }

    const plans = structure.reporting_plans || [];

    // Filter for Wisconsin if requested
    if (filterWI) {
      const isWI = plans.some(p => {
        const name = (p.plan_name || '').toLowerCase();
        return ['wisconsin', ' wi ', ' wi-', '-wi ', 'milwaukee', 'madison', 'green bay']
          .some(ind => name.includes(ind));
      });
      if (!isWI) continue;
    }

    const inNetworkFiles = (structure.in_network_files || []).map(f => ({
      description: f.description || '',
      location: f.location || '',
    }));

    const oonFile = structure.allowed_amount_file
      ? {
          description: structure.allowed_amount_file.description || '',
          location: structure.allowed_amount_file.location || '',
        }
      : null;

    const entry = {
      plans: plans.map(p => ({
        plan_name: p.plan_name,
        plan_id: p.plan_id,
        plan_id_type: p.plan_id_type,
        plan_market_type: p.plan_market_type,
      })),
      in_network_files: inNetworkFiles,
      allowed_amount_file: oonFile,
    };

    results.push(entry);
    console.log(`\n  Match #${results.length}:`);
    console.log(`    Plans: ${plans.map(p => p.plan_name).join(', ')}`);
    console.log(`    In-network files: ${inNetworkFiles.length}`);
    if (oonFile) console.log(`    OON file: ${oonFile.location.slice(0, 80)}...`);

    if (results.length >= limit) break;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Scanned: ${scanned} structures`);
  console.log(`Matched: ${results.length}`);
  console.log(`Total in-network file URLs: ${results.reduce((s, r) => s + r.in_network_files.length, 0)}`);

  return results;
}

// CLI
if (process.argv[1]?.endsWith('stream-toc.mjs')) {
  const tocUrl = process.argv[2];
  if (!tocUrl) {
    console.log('Usage: node stream-toc.mjs <toc_url> [--all] [--limit N]');
    console.log('  --all     Show all plans (default: Wisconsin only)');
    console.log('  --limit N Stop after N matches');
    process.exit(1);
  }

  const filterWI = !process.argv.includes('--all');
  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1]) : Infinity;

  try {
    const results = await streamTOC(tocUrl, { filterWI, limit });

    // Save results
    mkdirSync('../data/parsed', { recursive: true });
    const output = JSON.stringify({ toc_url: tocUrl, structures: results }, null, 2);
    const outPath = new URL('../data/parsed/toc_results.json', import.meta.url).pathname;
    createWriteStream(outPath).end(output);
    console.log(`\nSaved to ${outPath}`);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

export { streamTOC, fetchStream };
