/**
 * ClearPrice - In-Network Rate File Streaming Parser
 *
 * Streams massive (100GB+) in-network rate files and extracts only what we need.
 * Uses stream-json Parser with Pick + StreamArray for incremental parsing.
 *
 * Usage: node stream-rates.mjs <file_url> [--oon] [--output rates.csv] [--limit N]
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
import { createWriteStream } from 'fs';

// Common procedures people actually price-shop for
const TARGET_CPT_CODES = {
  '70553': 'MRI brain w/o & w/dye',
  '70551': 'MRI brain w/o dye',
  '73721': 'MRI joint lower extremity',
  '74177': 'CT abdomen & pelvis w/dye',
  '71260': 'CT chest w/dye',
  '77067': 'Screening mammography',
  '80053': 'Comprehensive metabolic panel',
  '85025': 'Complete blood count (CBC)',
  '81001': 'Urinalysis',
  '99213': 'Office visit, established, level 3',
  '99214': 'Office visit, established, level 4',
  '99203': 'Office visit, new, level 3',
  '27447': 'Total knee replacement',
  '29881': 'Knee arthroscopy/surgery',
  '43239': 'Upper GI endoscopy with biopsy',
  '45380': 'Colonoscopy with biopsy',
  '59400': 'Routine OB care (vaginal delivery)',
  '59510': 'Routine OB care (cesarean delivery)',
};

const TARGET_CODES = new Set(Object.keys(TARGET_CPT_CODES));

/**
 * Fetch a URL as a readable stream, following redirects and handling gzip.
 */
function fetchStream(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Consume the redirect body to free the socket
        res.resume();
        const redirectUrl = new URL(res.headers.location, url).href;
        return resolve(fetchStream(redirectUrl, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      // Check content-encoding, file extension, or URL path (ignoring query params)
      const urlPath = new URL(url).pathname;
      const isGzip = res.headers['content-encoding'] === 'gzip' ||
                     urlPath.endsWith('.gz');
      resolve(isGzip ? res.pipe(createGunzip()) : res);
    }).on('error', reject);
  });
}

function escapeCsv(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Stream an in-network rate file, extracting only target billing codes.
 */
async function streamInNetworkRates(fileUrl, { outputPath, limit = Infinity } = {}) {
  console.log(`\nStreaming in-network rates: ${fileUrl.slice(0, 100)}...`);
  console.log(`Filtering for ${TARGET_CODES.size} billing codes\n`);

  const stream = await fetchStream(fileUrl);

  const pipeline = chain([
    stream,
    makeParser(),
    pick({ filter: 'in_network' }),
    streamArray(),
  ]);

  const out = outputPath ? createWriteStream(outputPath) : process.stdout;
  const header = ['billing_code_type', 'billing_code', 'description', 'negotiated_type',
    'negotiated_rate', 'billing_class', 'setting', 'expiration_date',
    'provider_npi', 'provider_tin', 'negotiation_arrangement'].join(',') + '\n';
  out.write(header);

  let scanned = 0;
  let matched = 0;
  let rows = 0;

  return new Promise((resolve, reject) => {
    pipeline.on('data', ({ value: item }) => {
      scanned++;
      if (scanned % 5000 === 0) {
        process.stderr.write(`  Scanned ${scanned} items, matched ${matched}, rows ${rows}\r`);
      }

      const code = String(item.billing_code || '');
      if (!TARGET_CODES.has(code)) return;
      matched++;

      const codeType = item.billing_code_type || '';
      const description = item.description || '';
      const arrangement = item.negotiation_arrangement || '';

      for (const rateGroup of (item.negotiated_rates || [])) {
        const providers = [];

        for (const pg of (rateGroup.provider_groups || [])) {
          const tinObj = pg.tin || {};
          const tin = typeof tinObj === 'object' ? (tinObj.value || '') : String(tinObj);
          for (const npi of (pg.npi || [])) {
            providers.push([String(npi), tin]);
          }
        }

        // v2.0 provider_references
        if (providers.length === 0 && rateGroup.provider_references) {
          for (const ref of rateGroup.provider_references.slice(0, 10)) {
            providers.push([`ref:${ref}`, '']);
          }
        }

        for (const price of (rateGroup.negotiated_prices || [])) {
          for (const [npi, tin] of providers) {
            const row = [
              codeType, code, escapeCsv(description),
              price.negotiated_type || '', price.negotiated_rate ?? '',
              price.billing_class || '', price.setting || '',
              price.expiration_date || '', npi, tin, arrangement,
            ].join(',') + '\n';
            out.write(row);
            rows++;

            if (rows >= limit) {
              pipeline.destroy();
              if (outputPath) out.end();
              console.log(`\n\nLimit reached (${limit} rows). Scanned ${scanned}, matched ${matched}`);
              resolve({ scanned, matched, rows });
              return;
            }
          }
        }
      }
    });

    pipeline.on('end', () => {
      if (outputPath) out.end();
      console.log(`\n\nComplete: ${scanned} items scanned, ${matched} matched, ${rows} rows written`);
      resolve({ scanned, matched, rows });
    });

    pipeline.on('error', (err) => {
      console.error(`\nStream error: ${err.message}`);
      if (outputPath) out.end();
      // Resolve with partial results rather than rejecting
      resolve({ scanned, matched, rows, error: err.message });
    });
  });
}

/**
 * Stream an allowed-amounts (OON) file.
 */
async function streamAllowedAmounts(fileUrl, { outputPath, limit = Infinity } = {}) {
  console.log(`\nStreaming OON allowed amounts: ${fileUrl.slice(0, 100)}...`);

  const stream = await fetchStream(fileUrl);

  const pipeline = chain([
    stream,
    makeParser(),
    pick({ filter: 'out_of_network' }),
    streamArray(),
  ]);

  const out = outputPath ? createWriteStream(outputPath) : process.stdout;
  out.write('billing_code_type,billing_code,description,allowed_amount,billed_charge,billing_class,provider_npi,provider_tin\n');

  let scanned = 0;
  let rows = 0;

  return new Promise((resolve, reject) => {
    pipeline.on('data', ({ value: item }) => {
      scanned++;
      const code = String(item.billing_code || '');
      if (!TARGET_CODES.has(code)) return;

      const codeType = item.billing_code_type || '';
      const description = item.description || '';

      for (const aa of (item.allowed_amounts || [])) {
        const tinObj = aa.tin || {};
        const tin = typeof tinObj === 'object' ? (tinObj.value || '') : String(tinObj);
        const billingClass = aa.billing_class || '';

        for (const payment of (aa.payments || [])) {
          const allowed = payment.allowed_amount ?? '';
          for (const provider of (payment.providers || [])) {
            const billed = provider.billed_charge ?? '';
            for (const npi of (provider.npi || [])) {
              out.write([codeType, code, escapeCsv(description), allowed, billed, billingClass, String(npi), tin].join(',') + '\n');
              rows++;
              if (rows >= limit) {
                pipeline.destroy();
                if (outputPath) out.end();
                resolve({ scanned, rows });
                return;
              }
            }
          }
        }
      }
    });

    pipeline.on('end', () => {
      if (outputPath) out.end();
      console.log(`\nComplete: ${scanned} items scanned, ${rows} rows written`);
      resolve({ scanned, rows });
    });

    pipeline.on('error', (err) => {
      if (outputPath) out.end();
      resolve({ scanned, rows, error: err.message });
    });
  });
}

// CLI
const fileUrl = process.argv[2];
if (!fileUrl) {
  console.log('Usage: node stream-rates.mjs <file_url> [--oon] [--output rates.csv] [--limit N]');
  process.exit(1);
}

const isOON = process.argv.includes('--oon');
const outIdx = process.argv.indexOf('--output');
const outputPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;
const limIdx = process.argv.indexOf('--limit');
const limit = limIdx >= 0 ? parseInt(process.argv[limIdx + 1]) : Infinity;

try {
  if (isOON) {
    await streamAllowedAmounts(fileUrl, { outputPath, limit });
  } else {
    await streamInNetworkRates(fileUrl, { outputPath, limit });
  }
} catch (err) {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
}
