#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * One-shot script: resolves every unique city (Hebrew settlement name) in
 * seen-ads.json to a {lat, lng} pair via OpenStreetMap's Nominatim service
 * and persists the lookup table to dashboard/app/lib/city-coords.json.
 *
 * Nominatim ToS: max 1 req/sec, identifying User-Agent. We honor both.
 *
 * Usage:
 *   node scripts/geocode-cities.js                # geocode missing cities only (incremental)
 *   node scripts/geocode-cities.js --refresh      # re-geocode everything
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEEN_PATH = path.join(REPO_ROOT, 'state', 'seen-ads.json');
const OUT_PATH = path.join(REPO_ROOT, 'dashboard', 'app', 'lib', 'city-coords.json');
const USER_AGENT = 'yad2-hunter-dashboard/1.0 (https://github.com/Omezan/yad2-hunter)';

// Israel bounding box (loose) — keep Nominatim from returning hits in
// other countries that happen to share a transliteration.
const IL_VIEWBOX = '34.0,33.5,35.95,29.4';

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function uniqueCities() {
  const raw = loadJson(SEEN_PATH, { ads: {} });
  const ads = Array.isArray(raw) ? raw : Object.values(raw.ads || {});
  const set = new Set();
  for (const ad of ads) {
    const c = (ad.city || '').trim();
    if (c) set.add(c);
  }
  return [...set].sort();
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'he,en'
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function geocodeOnce(city) {
  const params = new URLSearchParams({
    q: city + ', Israel',
    format: 'json',
    limit: '1',
    countrycodes: 'il',
    viewbox: IL_VIEWBOX,
    bounded: '1'
  });
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const arr = await fetchJson(url);
  if (!Array.isArray(arr) || !arr.length) return null;
  const hit = arr[0];
  const lat = Number.parseFloat(hit.lat);
  const lng = Number.parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, source: 'nominatim', resolvedName: hit.display_name || null };
}

async function geocode(city) {
  // Try the literal city; if no hit, retry without quote-marks (some
  // settlements like גבעת כ״ח render with " or ׳ in seen-ads.json).
  const variants = new Set([city]);
  variants.add(city.replace(/["׳״'’]/g, ''));
  variants.add(city.replace(/[״]/g, '"'));

  for (const variant of variants) {
    try {
      const hit = await geocodeOnce(variant);
      if (hit) return hit;
    } catch (err) {
      console.warn(`  variant "${variant}" failed: ${err.message}`);
    }
    await sleep(1100); // honor 1 req/sec
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const existing = loadJson(OUT_PATH, {});
  const cities = uniqueCities();
  console.log(`unique cities in seen-ads.json: ${cities.length}`);

  const next = refresh ? {} : { ...existing };
  const todo = cities.filter((c) => refresh || !next[c]);

  if (!todo.length) {
    console.log('nothing to do — all cities already in city-coords.json');
    saveJson(OUT_PATH, sortKeys(next));
    return;
  }

  console.log(`will geocode: ${todo.length}`);
  let resolved = 0;
  let missed = 0;
  for (const city of todo) {
    const hit = await geocode(city);
    if (hit) {
      next[city] = { lat: hit.lat, lng: hit.lng };
      resolved += 1;
      console.log(`  ✓ ${city} → ${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)}`);
    } else {
      missed += 1;
      console.log(`  ✗ ${city} → no hit`);
    }
    await sleep(1100);
  }

  saveJson(OUT_PATH, sortKeys(next));
  console.log(`\nsummary: resolved=${resolved}, missed=${missed}, total stored=${Object.keys(next).length}`);
  if (missed) {
    const missing = cities.filter((c) => !next[c]);
    console.log('still missing:', missing.join(', '));
  }
}

function sortKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b, 'he'))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
