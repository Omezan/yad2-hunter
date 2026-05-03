#!/usr/bin/env node
/**
 * One-shot: read tombstones.json from the local state branch checkout,
 * probe each id against Yad2 with the same anti-bot-aware probe the
 * health-check uses, and:
 *   - For ids that are STILL ALIVE on Yad2: synthesise a minimal seen
 *     record from the latest scan's data and add it to seen-ads.json
 *     (silently — no Telegram notification). This prevents the next
 *     scan from re-announcing it as "new".
 *   - For ids that are CONFIRMED REMOVED (404/410): leave them out of
 *     seen-ads and emit them in stdout so they can be passed to the
 *     merge step via SEEN_ADS_FORCE_DELETE_IDS.
 *   - For ids that probe inconclusively (blocked / captcha / timeout):
 *     skip — we can't tell if they are alive or dead, and we'd rather
 *     have one false-positive notification than silently drop a
 *     listing the user wants to know about.
 *
 * After this finishes, tombstones.json is removed and the merge will
 * respect any actual deletions via SEEN_ADS_FORCE_DELETE_IDS.
 *
 * Usage:
 *   node scripts/backfill-from-tombstones.js \
 *     --tombstones=state/tombstones.json \
 *     --seen=state/seen-ads.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { probeListingsPresence } = require('../src/scraper/yad2');

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
}

function externalIdToUrl(externalId) {
  return `https://www.yad2.co.il/realestate/item/${externalId}`;
}

function searchIdFromExternalId(externalId) {
  // externalId looks like "north-and-valleys/normtgby" — first segment
  // is the district slug used by Yad2 in the URL, which matches our
  // searchId convention for the worker (one search per district).
  if (!externalId || !externalId.includes('/')) return null;
  return externalId.split('/')[0];
}

async function main() {
  const tombstonesPath = arg('tombstones', 'state/tombstones.json');
  const seenPath = arg('seen', 'state/seen-ads.json');

  if (!fs.existsSync(tombstonesPath)) {
    console.error(`[backfill] no tombstones file at ${tombstonesPath}`);
    process.exit(0);
  }

  const tombstoneFile = readJson(tombstonesPath);
  const ids = Object.keys(tombstoneFile.tombstones || {});
  if (!ids.length) {
    console.error('[backfill] empty tombstones — nothing to do');
    return;
  }

  console.error(`[backfill] probing ${ids.length} tombstoned id(s)...`);
  const urls = ids.map(externalIdToUrl);
  const results = await probeListingsPresence({
    urls,
    headless: true,
    timeoutMs: 18000,
    concurrency: 3,
    logger: console
  });

  const byUrl = new Map(results.map((r) => [r.url, r]));

  const alive = [];
  const removed = [];
  const inconclusive = [];

  for (const id of ids) {
    const r = byUrl.get(externalIdToUrl(id));
    if (!r) {
      inconclusive.push({ id, status: 'no-result', reason: 'probe returned no entry' });
      continue;
    }
    if (r.status === 'present') alive.push({ id, ...r });
    else if (r.status === 'removed') removed.push({ id, ...r });
    else inconclusive.push({ id, status: r.status, reason: r.reason });
  }

  console.error(
    `[backfill] alive=${alive.length}  removed=${removed.length}  inconclusive=${inconclusive.length}`
  );

  // Add the alive ones to seen-ads silently. Use a synthetic record
  // with firstSeenAt set to a time in the past so the dashboard
  // doesn't show them as "new" on the user's next visit.
  const seen = fs.existsSync(seenPath) ? readJson(seenPath) : { ads: {} };
  if (!seen.ads || typeof seen.ads !== 'object') seen.ads = {};
  const syntheticTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (const entry of alive) {
    if (seen.ads[entry.id]) continue; // already there, skip
    seen.ads[entry.id] = {
      externalId: entry.id,
      title: null,
      link: externalIdToUrl(entry.id),
      searchId: searchIdFromExternalId(entry.id),
      searchLabel: null,
      districtLabel: null,
      price: null,
      rooms: null,
      city: null,
      firstSeenAt: syntheticTime,
      lastSeenAt: syntheticTime
    };
  }
  writeJson(seenPath, seen);
  console.error(`[backfill] wrote ${alive.length} alive id(s) into ${seenPath}`);

  // Print the confirmed-removed list to stdout so the caller can pass
  // it to merge-state via SEEN_ADS_FORCE_DELETE_IDS.
  process.stdout.write(removed.map((r) => r.id).join(','));

  if (inconclusive.length) {
    console.error('[backfill] inconclusive entries (left untouched):');
    for (const e of inconclusive) {
      console.error(`  ${e.id}  [${e.status}] ${e.reason || ''}`);
    }
  }
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
