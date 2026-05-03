#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * One-shot script: resolves every unique city (Hebrew settlement name) in
 * seen-ads.json to a {lat, lng} pair via OpenStreetMap's Nominatim service
 * and persists the lookup table to dashboard/app/lib/city-coords.json.
 *
 * Important: each city is geocoded with a viewbox that matches its
 * Yad2 district. Without this constraint Nominatim cheerfully returns
 * homonymous settlements in completely different parts of Israel
 * (e.g. "ביכורה" in Beit Shean valley vs. "עין ביכורה" near
 * Jerusalem). When the viewbox-bounded query returns no hit, we fall
 * back to a country-wide search so the script never silently drops a
 * city.
 *
 * Nominatim ToS: max 1 req/sec, identifying User-Agent. Both honored.
 *
 * Usage:
 *   node scripts/geocode-cities.js                # geocode missing cities only (incremental)
 *   node scripts/geocode-cities.js --refresh      # re-geocode everything
 *   node scripts/geocode-cities.js --recheck      # re-geocode anything outside its district viewbox
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEEN_PATH = path.join(REPO_ROOT, 'state', 'seen-ads.json');
const OUT_PATH = path.join(REPO_ROOT, 'dashboard', 'app', 'lib', 'city-coords.json');
const USER_AGENT = 'yad2-hunter-dashboard/1.0 (https://github.com/Omezan/yad2-hunter)';

// Viewboxes are "minLng,maxLat,maxLng,minLat" per Nominatim spec.
// The country-wide fallback is intentionally loose so we never drop a
// city; the per-district boxes are tight enough to disambiguate
// homonyms (Maas in Petah Tikva vs. Maas in Rehovot etc).
const VIEWBOX_IL = '34.0,33.5,35.95,29.4';

const DISTRICT_VIEWBOX = {
  // Northern Galilee + Golan + Jezreel + Beit Shean valleys.
  'north-valleys': '34.85,33.40,35.95,32.40',
  // Jerusalem hills + Modi'in surroundings.
  'jerusalem':     '34.85,32.10,35.30,31.55',
  // Negev + lowlands south of Latrun.
  'south':         '34.10,31.85,35.50,29.50',
  // Sharon + central plain.
  'center-sharon': '34.65,32.55,35.20,31.85',
  // Mount Carmel + northern coastal plain (Hadera-Haifa-Acre).
  'coastal-north': '34.80,33.10,35.20,32.30'
};

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Build a Map<city, Set<districtId>> from seen-ads.json so we know
 * which districts each settlement appears in. A small number of
 * settlements legitimately appear in multiple districts in Yad2's
 * search URLs - we'll geocode using the first one for now and trust
 * Nominatim's relevance ranking for the rest.
 */
function indexCitiesByDistrict() {
  const raw = loadJson(SEEN_PATH, { ads: {} });
  const ads = Array.isArray(raw) ? raw : Object.values(raw.ads || {});
  const map = new Map();
  for (const ad of ads) {
    const city = (ad.city || '').trim();
    if (!city) continue;
    const districtId = ad.searchId || null;
    if (!map.has(city)) map.set(city, new Set());
    if (districtId) map.get(city).add(districtId);
  }
  return map;
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

async function geocodeOnce(city, { viewbox, bounded }) {
  const params = new URLSearchParams({
    q: city + ', Israel',
    format: 'json',
    limit: '1',
    countrycodes: 'il',
    viewbox,
    bounded: bounded ? '1' : '0'
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

async function geocode(city, districts) {
  const variants = new Set([city]);
  variants.add(city.replace(/["׳״'’]/g, ''));
  variants.add(city.replace(/[״]/g, '"'));

  const tries = [];
  // First, try every district the city belongs to with a tight bounded box.
  for (const districtId of districts) {
    const viewbox = DISTRICT_VIEWBOX[districtId];
    if (!viewbox) continue;
    tries.push({ viewbox, bounded: true, label: `district:${districtId}` });
  }
  // Last-resort: search anywhere in Israel.
  tries.push({ viewbox: VIEWBOX_IL, bounded: false, label: 'fallback:il' });

  for (const variant of variants) {
    for (const attempt of tries) {
      try {
        const hit = await geocodeOnce(variant, attempt);
        if (hit) {
          return { ...hit, viaVariant: variant, viaAttempt: attempt.label };
        }
      } catch (err) {
        console.warn(`  variant "${variant}" via ${attempt.label} failed: ${err.message}`);
      }
      await sleep(1100);
    }
  }
  return null;
}

function isInsideViewbox(coord, viewbox) {
  if (!coord || !viewbox) return false;
  const [minLng, maxLat, maxLng, minLat] = viewbox.split(',').map(Number);
  return (
    coord.lng >= minLng &&
    coord.lng <= maxLng &&
    coord.lat <= maxLat &&
    coord.lat >= minLat
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const recheck = process.argv.includes('--recheck');
  const existing = loadJson(OUT_PATH, {});
  const cityIndex = indexCitiesByDistrict();

  console.log(`unique cities in seen-ads.json: ${cityIndex.size}`);

  const next = refresh ? {} : { ...existing };

  // Decide which cities to geocode this run.
  const todo = [];
  for (const [city, districts] of cityIndex.entries()) {
    if (refresh) {
      todo.push({ city, districts });
      continue;
    }
    if (!next[city]) {
      todo.push({ city, districts });
      continue;
    }
    if (recheck) {
      // If the existing coord lies outside ALL known district boxes
      // for this city, re-geocode it.
      const districtList = [...districts];
      const insideAny = districtList.some((d) =>
        isInsideViewbox(next[city], DISTRICT_VIEWBOX[d])
      );
      if (!insideAny && districtList.length > 0) {
        console.log(
          `  recheck: ${city} (${districtList.join(',')}) currently at ` +
            `${next[city].lat.toFixed(4)},${next[city].lng.toFixed(4)} - ` +
            `outside district viewbox`
        );
        todo.push({ city, districts });
      }
    }
  }

  if (!todo.length) {
    console.log('nothing to do');
    saveJson(OUT_PATH, sortKeys(next));
    return;
  }

  console.log(`will geocode: ${todo.length}`);
  let resolved = 0;
  let missed = 0;
  for (const { city, districts } of todo) {
    const districtList = [...districts];
    const hit = await geocode(city, districtList);
    if (hit) {
      next[city] = { lat: hit.lat, lng: hit.lng };
      resolved += 1;
      console.log(
        `  ✓ ${city} → ${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)} ` +
          `(${hit.viaAttempt})`
      );
    } else {
      missed += 1;
      console.log(`  ✗ ${city} → no hit (districts: ${districtList.join(',') || '?'})`);
    }
  }

  saveJson(OUT_PATH, sortKeys(next));
  console.log(`\nsummary: resolved=${resolved}, missed=${missed}, total stored=${Object.keys(next).length}`);
  if (missed) {
    const stillMissing = [...cityIndex.keys()].filter((c) => !next[c]);
    console.log('still missing:', stillMissing.join(', '));
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
