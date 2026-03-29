/**
 * ClearPrice - Insurer URL Discovery
 *
 * Fetches known insurer TOC entry points and saves discovered file URLs.
 * Run this first to populate data/parsed/insurer-urls.json
 */

import https from 'https';
import http from 'http';
import { createGunzip } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';

/**
 * Known insurer TOC endpoints for Wisconsin-relevant plans.
 *
 * UHC: Has a web portal at transparency-in-coverage.uhc.com
 *   - TOC index: fetch first page to get structure
 * Anthem: S3 bucket with massive TOC
 * Medica: TBD
 */

const INSURERS = {
  uhc: {
    name: 'UnitedHealthcare',
    // UHC provides a browsable API - the TOC is paginated
    // This is a sample TOC URL - the actual one is discoverable from their portal
    toc_url: 'https://transparency-in-coverage.uhc.com/api/v1/uhc/blobs/download/2026-03-01/2026-03-01_United-HealthCare-Services--Inc-_Third-Party-Administrator_index.json.gz',
    notes: 'UHC has multiple TOC files per entity. Portal at transparency-in-coverage.uhc.com',
  },
  anthem: {
    name: 'Anthem/Elevance',
    toc_url: 'https://antm-pt-prod-dataz-nogbd-nophi-us-east1.s3.amazonaws.com/anthem/2026-03-01_anthem_index.json.gz',
    notes: 'Anthem TOC is ~30GB. Need to stream very carefully.',
  },
  medica: {
    name: 'Medica',
    toc_url: null, // Need to discover
    notes: 'URL not yet discovered. Check medica.com or CMS lookup.',
  },
};

/**
 * Probe a URL to check if it's accessible and get file size.
 */
function probeUrl(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method: 'HEAD' }, (res) => {
      resolve({
        url,
        status: res.statusCode,
        contentLength: res.headers['content-length'],
        contentType: res.headers['content-type'],
        lastModified: res.headers['last-modified'],
      });
    });
    req.on('error', (err) => resolve({ url, error: err.message }));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ url, error: 'timeout' });
    });
    req.end();
  });
}

/**
 * Fetch a small sample from a TOC URL to verify structure.
 */
function fetchSample(url, maxBytes = 50000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'Range': `bytes=0-${maxBytes}` } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchSample(res.headers.location, maxBytes));
      }

      const chunks = [];
      let size = 0;
      const stream = url.endsWith('.gz') ? res.pipe(createGunzip()) : res;

      stream.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
        }
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', (err) => {
        // Might error due to early close on gzip - that's ok
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('ClearPrice - Insurer URL Discovery\n');
  console.log('Probing known TOC endpoints...\n');

  const results = {};

  for (const [key, insurer] of Object.entries(INSURERS)) {
    console.log(`--- ${insurer.name} ---`);

    if (!insurer.toc_url) {
      console.log('  No URL yet. Skipping.\n');
      results[key] = { ...insurer, status: 'no_url' };
      continue;
    }

    // Probe the URL
    console.log(`  Probing: ${insurer.toc_url.slice(0, 80)}...`);
    const probe = await probeUrl(insurer.toc_url);
    console.log(`  Status: ${probe.status || probe.error}`);
    if (probe.contentLength) {
      const sizeMB = (parseInt(probe.contentLength) / 1024 / 1024).toFixed(1);
      console.log(`  Size: ${sizeMB} MB`);
    }

    // Try to fetch a sample
    if (probe.status === 200 || probe.status === 206) {
      console.log('  Fetching sample...');
      try {
        const sample = await fetchSample(insurer.toc_url);
        // Try to parse what we got
        const truncated = sample.slice(0, 2000);
        console.log(`  Sample (first 2000 chars):\n${truncated}\n`);
        results[key] = { ...insurer, status: 'accessible', sample_preview: truncated };
      } catch (err) {
        console.log(`  Sample fetch failed: ${err.message}\n`);
        results[key] = { ...insurer, status: 'probe_ok_sample_failed', probe };
      }
    } else {
      console.log('  Not directly accessible. May need different URL pattern.\n');
      results[key] = { ...insurer, status: 'not_accessible', probe };
    }
  }

  // Save results
  mkdirSync(new URL('../data/parsed', import.meta.url).pathname, { recursive: true });
  const outPath = new URL('../data/parsed/insurer-discovery.json', import.meta.url).pathname;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(console.error);
