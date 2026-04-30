#!/usr/bin/env node
/**
 * One-shot audit: visit every listing in seen-ads.json on Yad2 and
 * patch any field that differs from what the live detail page shows.
 *
 * For each record we try, in order:
 *   1. __NEXT_DATA__ JSON blob (most reliable on Yad2's Next.js app)
 *   2. JSON-LD <script type="application/ld+json"> blocks
 *   3. DOM scraping (h1/h2 + visible price/rooms text)
 *
 * If all three fail (captcha / 4xx / etc.) we leave the record
 * untouched - no overwrites with blank values.
 *
 * Usage:
 *   node scripts/audit-listings-against-yad2.js path/to/seen-ads.json [--limit=20] [--only=externalId,...]
 *
 * Writes the patched seen-ads.json IN PLACE and prints a human
 * summary on stderr (so the patched JSON can be piped if needed).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CONCURRENCY = 3;
const PER_REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const HUMANIZE_MIN_MS = 800;
const HUMANIZE_MAX_MS = 2500;

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

function deepFindFirst(obj, predicate, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 10) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindFirst(item, predicate, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (predicate(obj)) return obj;
  for (const key of Object.keys(obj)) {
    const found = deepFindFirst(obj[key], predicate, depth + 1);
    if (found) return found;
  }
  return null;
}

function pickText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text.trim() || null;
    if (typeof v.name === 'string') return v.name.trim() || null;
    if (typeof v.title === 'string') return v.title.trim() || null;
  }
  return null;
}

const PROPERTY_TYPE_PREFIXES = [
  "בית פרטי/ קוטג'",
  "בית פרטי / קוטג'",
  'בית פרטי',
  'דירת גן',
  'דירת גג',
  'דירה',
  'פנטהאוז',
  'מיני פנטהאוז',
  'דופלקס',
  'טריפלקס',
  'יחידת דיור',
  'וילה',
  'משק',
  'סטודיו',
  'סאבלט',
  'דו משפחתי'
];

function buildTitle(propertyType, city) {
  const parts = [propertyType, city].filter((p) => typeof p === 'string' && p.trim());
  if (!parts.length) return null;
  return parts.join(', ');
}

async function extractFromPage(page, url) {
  const navResult = await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: PER_REQUEST_TIMEOUT_MS })
    .then((r) => ({ ok: true, response: r }))
    .catch((err) => ({ ok: false, error: err.message }));

  if (!navResult.ok) {
    return { ok: false, reason: `goto failed: ${navResult.error}` };
  }

  const httpStatus = navResult.response ? navResult.response.status() : null;
  if (httpStatus === 404 || httpStatus === 410) {
    return { ok: false, reason: `HTTP ${httpStatus}`, removed: true };
  }

  // Wait briefly for SSR data to be available.
  await page.waitForTimeout(500);

  const captured = await page
    .evaluate(() => {
      function readNextData() {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        try {
          return JSON.parse(el.textContent || '');
        } catch (_) {
          return null;
        }
      }
      function readJsonLd() {
        const blocks = [];
        document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
          try {
            blocks.push(JSON.parse(el.textContent || ''));
          } catch (_) {
            // ignore bad blocks
          }
        });
        return blocks;
      }
      const titleHeading = (document.querySelector('h1')?.innerText || '').trim();
      const secondaryHeading = (document.querySelector('h2')?.innerText || '').trim();
      const bodyText = (document.body?.innerText || '').slice(0, 8000);
      return {
        nextData: readNextData(),
        jsonLd: readJsonLd(),
        titleHeading,
        secondaryHeading,
        bodyText,
        documentTitle: document.title || ''
      };
    })
    .catch((err) => ({ error: err.message }));

  if (!captured || captured.error) {
    return { ok: false, reason: `evaluate failed: ${captured?.error || 'unknown'}` };
  }

  // Anti-bot detection — if the page is the captcha, don't pretend we
  // got real data.
  const titleLower = (captured.documentTitle || '').toLowerCase();
  const isCaptcha =
    titleLower.includes('shieldsquare') ||
    titleLower.includes('are you for real') ||
    titleLower.includes('captcha') ||
    /are you for real|captcha digest|אבטחת אתר/i.test(captured.bodyText || '');

  // Extract from __NEXT_DATA__ first (gold).
  let city = null;
  let propertyType = null;
  let price = null;
  let rooms = null;

  if (captured.nextData) {
    const root = deepFindFirst(captured.nextData, (o) => {
      if (!o || typeof o !== 'object') return false;
      if (
        (typeof o.token === 'string' || typeof o.orderId === 'string') &&
        (o.address || o.price || o.additionalDetails)
      ) {
        return true;
      }
      return false;
    });

    const addressEntry = deepFindFirst(captured.nextData, (o) => {
      if (!o || typeof o !== 'object') return false;
      if (o.address && typeof o.address === 'object') {
        const a = o.address;
        if (a.city && (a.city.text || typeof a.city === 'string')) return true;
        if (a.neighborhood || a.street || a.house) return true;
      }
      return false;
    });

    const node = root || addressEntry;
    if (node) {
      const addr = node.address || (addressEntry && addressEntry.address) || {};
      city = pickText(addr.city);
      const additional = node.additionalDetails || {};
      propertyType =
        pickText(additional.property) ||
        pickText(additional.propertyCondition) ||
        pickText(node.realestateType) ||
        pickText(node.propertyType);
      if (typeof additional.roomsCount === 'number') rooms = additional.roomsCount;
      else if (typeof node.roomsCount === 'number') rooms = node.roomsCount;
      // Yad2's __NEXT_DATA__ uses 0 to mean "no price specified" -
      // treat that as null so we don't overwrite a real existing
      // price with a placeholder.
      if (typeof node.price === 'number' && node.price > 0) price = node.price;
      else if (
        node.metaData &&
        typeof node.metaData.price === 'number' &&
        node.metaData.price > 0
      ) {
        price = node.metaData.price;
      }
    }
  }

  // Fall back to JSON-LD for price.
  if (price == null && Array.isArray(captured.jsonLd)) {
    for (const block of captured.jsonLd) {
      const offer = deepFindFirst(block, (o) => {
        if (!o || typeof o !== 'object') return false;
        const direct = typeof o.price === 'number' && o.price > 0;
        const nested =
          o.priceSpecification &&
          typeof o.priceSpecification.price === 'number' &&
          o.priceSpecification.price > 0;
        return direct || nested;
      });
      if (offer) {
        if (typeof offer.price === 'number' && offer.price > 0) price = offer.price;
        else if (
          offer.priceSpecification &&
          typeof offer.priceSpecification.price === 'number' &&
          offer.priceSpecification.price > 0
        ) {
          price = offer.priceSpecification.price;
        }
        if (price != null) break;
      }
    }
  }

  // Fall back to DOM scraping (only for cases where __NEXT_DATA__ was
  // missing some field).
  if (price == null && captured.bodyText) {
    const cleanText = captured.bodyText.replace(/[\u200e\u200f]/g, '');
    const noPriceHint = /לא\s+צוין\s+מחיר/.test(cleanText);
    if (!noPriceHint) {
      const m = cleanText.match(/([\d.,]+)\s*₪/);
      if (m) {
        const numeric = Number.parseInt(m[1].replace(/[^\d]/g, ''), 10);
        if (Number.isFinite(numeric) && numeric > 100) price = numeric;
      }
    }
  }

  if (rooms == null && captured.bodyText) {
    const m = captured.bodyText.match(/(\d+(?:\.\d+)?)\s*חדרים/);
    if (m) {
      const v = Number.parseFloat(m[1]);
      if (Number.isFinite(v) && v > 0) rooms = v;
    }
  }

  // Anti-bot pages have no usable structured data. Treat as inconclusive.
  if (isCaptcha && !city && price == null) {
    return { ok: false, reason: 'captcha/anti-bot', isCaptcha: true };
  }

  // Yad2 "removed" UX.
  if (
    /המודעה\s+(הוסרה|אינה\s+זמינה|לא\s+קיימת|נמחקה|כבר\s+אינה\s+פעילה)/.test(captured.bodyText || '')
  ) {
    return { ok: false, reason: 'listing removed by Yad2', removed: true };
  }

  return {
    ok: true,
    city: city || null,
    propertyType: propertyType || null,
    price: price ?? null,
    rooms: rooms ?? null,
    title: buildTitle(propertyType, city)
  };
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error(
      'usage: node scripts/audit-listings-against-yad2.js <seen-ads.json> [--limit=N] [--only=ID,ID]'
    );
    process.exit(2);
  }
  if (!fs.existsSync(target)) {
    console.error(`file not found: ${target}`);
    process.exit(2);
  }
  const limit = arg('limit') ? Number.parseInt(arg('limit'), 10) : null;
  const onlyArg = arg('only');
  const onlyIds = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;
  const dryRun = flag('dry-run');

  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!data || typeof data.ads !== 'object') {
    console.error('seen-ads.json is missing the `ads` object');
    process.exit(2);
  }

  const allRecords = Object.entries(data.ads);
  let queue = allRecords.filter(([id]) => !onlyIds || onlyIds.has(id));
  if (limit) queue = queue.slice(0, limit);
  console.error(`[audit] scanning ${queue.length} listings (concurrency=${CONCURRENCY})`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'he-IL',
    viewport: { width: 1440, height: 1200 },
    extraHTTPHeaders: {
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    }
  });

  // Warmup
  try {
    const wp = await context.newPage();
    await wp.goto('https://www.yad2.co.il/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await wp.waitForTimeout(rand(1500, 3000));
    // Visit a search feed first to look more like a real session
    await wp.goto('https://www.yad2.co.il/realestate/rent', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => null);
    await wp.waitForTimeout(rand(1500, 3000));
    await wp.close();
  } catch (e) {
    console.error('[audit] warmup failed:', e.message);
  }

  const pages = await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => context.newPage())
  );

  const results = {
    total: queue.length,
    visited: 0,
    updated: 0,
    removed: 0,
    blocked: 0,
    unchanged: 0,
    failed: 0,
    fieldDeltas: { city: 0, title: 0, price: 0, rooms: 0 },
    samples: []
  };

  async function reWarmup(page) {
    try {
      await page.goto('https://www.yad2.co.il/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      await page.waitForTimeout(rand(1500, 3000));
    } catch (e) {
      // best effort
    }
  }

  let nextIndex = 0;

  async function workerLoop(page) {
    while (true) {
      const idx = nextIndex++;
      if (idx >= queue.length) return;
      const [id, record] = queue[idx];
      const url = record.link;
      if (!url) {
        results.failed += 1;
        continue;
      }

      let attempt = 0;
      let outcome = null;
      while (attempt < MAX_RETRIES) {
        attempt += 1;
        outcome = await extractFromPage(page, url);
        if (outcome.ok) break;
        if (outcome.removed) break;
        if (outcome.isCaptcha) await reWarmup(page);
        await page.waitForTimeout(rand(1200, 2200));
      }

      results.visited += 1;
      if (!outcome.ok) {
        if (outcome.removed) {
          results.removed += 1;
          // Mark for deletion
          record.__remove = true;
        } else if (outcome.isCaptcha) {
          results.blocked += 1;
        } else {
          results.failed += 1;
        }
        process.stderr.write(`  [${results.visited}/${queue.length}] ${id} ✗ ${outcome.reason}\n`);
        await page.waitForTimeout(rand(HUMANIZE_MIN_MS, HUMANIZE_MAX_MS));
        continue;
      }

      const before = {
        title: record.title || null,
        city: record.city || null,
        price: typeof record.price === 'number' ? record.price : null,
        rooms: typeof record.rooms === 'number' ? record.rooms : null
      };
      const after = {
        title: outcome.title || before.title,
        city: outcome.city || before.city,
        price: outcome.price ?? before.price,
        rooms: outcome.rooms ?? before.rooms
      };

      let changed = false;
      const deltas = [];
      for (const k of ['city', 'title', 'price', 'rooms']) {
        if (before[k] !== after[k] && after[k] != null) {
          changed = true;
          results.fieldDeltas[k] += 1;
          deltas.push(`${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
        }
      }

      if (changed) {
        results.updated += 1;
        record.title = after.title;
        record.city = after.city;
        record.price = after.price;
        record.rooms = after.rooms;
        if (results.samples.length < 30) {
          results.samples.push(`${id}: ${deltas.join(' | ')}`);
        }
        process.stderr.write(`  [${results.visited}/${queue.length}] ${id} ✓ ${deltas.join(', ')}\n`);
      } else {
        results.unchanged += 1;
        process.stderr.write(`  [${results.visited}/${queue.length}] ${id} = unchanged\n`);
      }

      await page.waitForTimeout(rand(HUMANIZE_MIN_MS, HUMANIZE_MAX_MS));
    }
  }

  await Promise.all(pages.map((p) => workerLoop(p)));

  // Apply removals.
  for (const [id, record] of allRecords) {
    if (record && record.__remove) {
      delete data.ads[id];
    }
    if (record) {
      delete record.__remove;
    }
  }

  if (!dryRun) {
    fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  }

  console.error('\n=== AUDIT SUMMARY ===');
  console.error(`total queued:   ${results.total}`);
  console.error(`visited:        ${results.visited}`);
  console.error(`updated:        ${results.updated}`);
  console.error(`unchanged:      ${results.unchanged}`);
  console.error(`removed:        ${results.removed}`);
  console.error(`blocked:        ${results.blocked}`);
  console.error(`failed:         ${results.failed}`);
  console.error(`field deltas:   city=${results.fieldDeltas.city} title=${results.fieldDeltas.title} price=${results.fieldDeltas.price} rooms=${results.fieldDeltas.rooms}`);
  console.error(`\nSAMPLES:`);
  for (const s of results.samples) console.error(`  ${s}`);

  await context.close();
  await browser.close();
}

main().catch((err) => {
  console.error('[audit] fatal:', err);
  process.exit(1);
});
