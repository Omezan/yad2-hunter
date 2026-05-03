const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const { isYad2ErrorText } = require('../scraper/yad2');

const PLACEHOLDER_TITLES = new Set(['מודעה', 'מודעה ללא כותרת']);

// Bare property type strings ("דירה", "בית פרטי/ קוטג'") that we
// treat as low-quality titles - if a fresh scan offers a canonical
// "PROPERTY_TYPE, CITY" heading, we prefer that.
const PROPERTY_TYPE_ONLY_TITLES = new Set([
  'דירה',
  "בית פרטי",
  "בית פרטי/ קוטג'",
  "בית פרטי / קוטג'",
  'דירת גן',
  'דירת גג',
  'גג/ פנטהאוז',
  'גג / פנטהאוז',
  'דו משפחתי',
  'פנטהאוז',
  'יחידת דיור',
  'מיני פנטהאוז',
  'דופלקס',
  'טריפלקס',
  'וילה',
  'משק',
  'משק חקלאי',
  'סטודיו',
  'סאבלט'
]);

function isPoisonString(value) {
  return typeof value === 'string' && isYad2ErrorText(value);
}

function isPlaceholderTitle(value) {
  return typeof value === 'string' && PLACEHOLDER_TITLES.has(value.trim());
}

function isPropertyTypeOnlyTitle(value) {
  return typeof value === 'string' && PROPERTY_TYPE_ONLY_TITLES.has(value.trim());
}

// "Low-quality" titles we should overwrite whenever a fresh,
// canonical "PROPERTY_TYPE, CITY" heading is available:
//   - placeholder ("מודעה")
//   - poison (error widget / anti-bot text)
//   - bare property type ("בית פרטי/ קוטג'")
//   - agency / brand strings ("TM Agassi GROUP", "RE/MAX Paradise")
//   - street-address shapes (digits, no comma)
function isLowQualityTitle(value) {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (isPoisonString(trimmed)) return true;
  if (isPlaceholderTitle(trimmed)) return true;
  if (isPropertyTypeOnlyTitle(trimmed)) return true;
  // Agency / realtor markers.
  if (/נדל[״"']?ן/.test(trimmed)) return true;
  if (/RE\/?MAX|UNISTATE|REAL\s+ESTATE|REALTY|REALITY/i.test(trimmed)) return true;
  if (/תיווך|נכסים|יזמות|שיווק נדל|קפיטל/.test(trimmed)) return true;
  // Mixed-case Latin brand strings ("TM Agassi GROUP", "Sky Realty"):
  // any title that is mostly Latin letters with no Hebrew is suspect
  // because real Yad2 headings are Hebrew.
  if (/^[A-Za-z][A-Za-z0-9 +\-/.]{2,}$/.test(trimmed)) return true;
  // Street-address shape: contains digits and no comma → it's an
  // address line, not a property heading.
  if (/\d/.test(trimmed) && !trimmed.includes(',')) return true;
  return false;
}

// A "canonical" title is a Yad2 list-card heading: contains a comma
// AND no digits (digits in a heading would mean a street number).
function isCanonicalHeading(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.includes(',')) return false;
  if (isPoisonString(trimmed)) return false;
  return true;
}

// Pick the field we should keep on disk when refreshing an existing
// record. Prefer the freshly-enriched value when:
//   - the existing value is missing / blank, or
//   - the existing value looks like the Yad2 error widget.
// Otherwise keep what's already in seen so we don't overwrite a real
// value with a (possibly transient) blank.
function preferFreshField(existingValue, freshValue) {
  if (
    existingValue === null ||
    existingValue === undefined ||
    existingValue === '' ||
    isPoisonString(existingValue)
  ) {
    return freshValue ?? null;
  }
  return existingValue;
}

const SEEN_FILE = 'seen-ads.json';
const RUNS_FILE = 'runs.json';
const TOMBSTONES_FILE = 'tombstones.json';

// How long a tombstone suppresses an externalId from being re-added by
// the race-safe merge. After this window, if Yad2 re-publishes the
// listing, the worker treats it as a brand-new ad (Telegram notice +
// fresh firstSeenAt). 30 days of retention is plenty - well past any
// "is this a repost?" window.
const TOMBSTONE_SUPPRESS_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function getStatePath(filename) {
  return path.join(env.STATE_DIR, filename);
}

function ensureStateDir() {
  if (!fs.existsSync(env.STATE_DIR)) {
    fs.mkdirSync(env.STATE_DIR, { recursive: true });
  }
}

function readJsonSafe(filename, fallback) {
  const filePath = getStatePath(filename);
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Could not parse ${filename}, starting fresh: ${error.message}`);
    return fallback;
  }
}

function writeJson(filename, data) {
  ensureStateDir();
  const filePath = getStatePath(filename);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function loadSeenAds() {
  const data = readJsonSafe(SEEN_FILE, { ads: {} });
  return data.ads && typeof data.ads === 'object' ? data : { ads: {} };
}

function saveSeenAds(seen) {
  writeJson(SEEN_FILE, seen);
}

function loadRuns() {
  const data = readJsonSafe(RUNS_FILE, { runs: [] });
  return Array.isArray(data.runs) ? data : { runs: [] };
}

function saveRuns(runs) {
  writeJson(RUNS_FILE, runs);
}

function loadTombstones() {
  const data = readJsonSafe(TOMBSTONES_FILE, { tombstones: {} });
  if (!data || typeof data !== 'object' || !data.tombstones) return { tombstones: {} };
  return data;
}

function saveTombstones(file) {
  writeJson(TOMBSTONES_FILE, file);
}

/**
 * Append (or refresh) a set of tombstones for ads that were just
 * deleted from seen-ads.json. Each tombstone records the externalId,
 * the time of deletion, and which worker recorded it - all useful
 * for debugging stale-merge bugs.
 */
function recordTombstones(externalIds, { reason = 'removed', recordedBy = 'worker' } = {}) {
  if (!externalIds || !externalIds.length) return;
  const file = loadTombstones();
  const now = new Date().toISOString();
  for (const id of externalIds) {
    if (!id) continue;
    file.tombstones[id] = {
      externalId: id,
      removedAt: now,
      reason,
      recordedBy
    };
  }
  // Drop tombstones older than the retention window so this file
  // can't grow unbounded.
  const cutoff = Date.now() - TOMBSTONE_RETENTION_MS;
  for (const [id, entry] of Object.entries(file.tombstones)) {
    const ts = Date.parse(entry.removedAt || '');
    if (Number.isFinite(ts) && ts < cutoff) {
      delete file.tombstones[id];
    }
  }
  saveTombstones(file);
}

/**
 * True if `externalId` has a tombstone within the suppression window.
 * The worker uses this to ignore a Yad2 result that matches a
 * recently-deleted listing - which prevents the merge race from
 * silently un-deleting it. After the suppression window expires the
 * id is treated as a brand-new listing.
 */
function isTombstonedRecently(externalId, { now = Date.now() } = {}) {
  if (!externalId) return false;
  const file = loadTombstones();
  const entry = file.tombstones[externalId];
  if (!entry) return false;
  const ts = Date.parse(entry.removedAt || '');
  if (!Number.isFinite(ts)) return false;
  return now - ts < TOMBSTONE_SUPPRESS_MS;
}

function pruneSeenAds(seen, retentionDays) {
  if (!retentionDays || retentionDays <= 0) {
    return seen;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const pruned = {};

  for (const [externalId, record] of Object.entries(seen.ads || {})) {
    const lastSeen = Date.parse(record.lastSeenAt || record.firstSeenAt || '');
    if (Number.isNaN(lastSeen) || lastSeen >= cutoff) {
      pruned[externalId] = record;
    }
  }

  return { ads: pruned };
}

function recordRun(runEntry) {
  const runs = loadRuns();
  runs.runs.unshift(runEntry);
  if (runs.runs.length > env.HISTORY_LIMIT) {
    runs.runs.length = env.HISTORY_LIMIT;
  }
  saveRuns(runs);
}

function splitNewAndExisting(ads) {
  const seen = loadSeenAds();
  const newAds = [];
  const existingAds = [];

  for (const ad of ads) {
    if (seen.ads[ad.externalId]) {
      existingAds.push(ad);
    } else {
      newAds.push(ad);
    }
  }

  return { newAds, existingAds };
}

const REMOVAL_TRUST_MIN_LIVE_COUNT = 1;
const REMOVAL_TRUST_MIN_RATIO = 0.5;

function removeDeletedAds(seen, scrapedAds = [], scrapedSearchIds = []) {
  const successfulSearchIds = new Set(scrapedSearchIds);
  if (!successfulSearchIds.size) {
    return { seen, removed: [], skippedDistricts: [] };
  }

  const liveByDistrict = new Map();
  for (const id of successfulSearchIds) {
    liveByDistrict.set(id, new Set());
  }
  for (const ad of scrapedAds) {
    if (!ad || !ad.externalId) continue;
    const set = liveByDistrict.get(ad.searchId);
    if (set) set.add(ad.externalId);
  }

  const seenCountByDistrict = new Map();
  for (const record of Object.values(seen.ads || {})) {
    if (!record || !record.searchId) continue;
    seenCountByDistrict.set(
      record.searchId,
      (seenCountByDistrict.get(record.searchId) || 0) + 1
    );
  }

  const trustworthyDistricts = new Set();
  const skippedDistricts = [];
  for (const districtId of successfulSearchIds) {
    const liveCount = liveByDistrict.get(districtId)?.size || 0;
    const seenCount = seenCountByDistrict.get(districtId) || 0;

    // Refuse to act when a successful scrape returned suspiciously few ads
    // compared to what we have stored. This prevents anti-bot pages that
    // return 0 (or near-zero) results from wiping the seen index.
    if (liveCount < REMOVAL_TRUST_MIN_LIVE_COUNT) {
      skippedDistricts.push({ searchId: districtId, reason: 'no-live-ads', liveCount, seenCount });
      continue;
    }
    if (seenCount > 0 && liveCount / seenCount < REMOVAL_TRUST_MIN_RATIO) {
      skippedDistricts.push({
        searchId: districtId,
        reason: 'live-too-low-vs-seen',
        liveCount,
        seenCount,
        ratio: liveCount / seenCount
      });
      continue;
    }
    trustworthyDistricts.add(districtId);
  }

  const removed = [];
  const ads = { ...(seen.ads || {}) };
  for (const [externalId, record] of Object.entries(ads)) {
    if (!record || !trustworthyDistricts.has(record.searchId)) continue;
    const live = liveByDistrict.get(record.searchId);
    if (live && !live.has(externalId)) {
      removed.push({
        externalId,
        searchId: record.searchId,
        title: record.title || null,
        link: record.link || null
      });
      delete ads[externalId];
    }
  }

  return { seen: { ...seen, ads }, removed, skippedDistricts };
}

function commitAds({
  newAds = [],
  existingAds = [],
  allScrapedAds = null,
  scrapedSearchIds = null
}) {
  let seen = loadSeenAds();
  const now = new Date().toISOString();
  let removed = [];
  let skippedDistricts = [];

  if (Array.isArray(allScrapedAds) && Array.isArray(scrapedSearchIds)) {
    const result = removeDeletedAds(seen, allScrapedAds, scrapedSearchIds);
    seen = result.seen;
    removed = result.removed;
    skippedDistricts = result.skippedDistricts || [];

    // Persist tombstones for the freshly-removed ids so the next
    // race-safe merge cannot resurrect them.
    if (removed.length) {
      try {
        recordTombstones(
          removed.map((r) => r.externalId),
          { reason: 'removed-by-scan', recordedBy: 'commitAds' }
        );
      } catch (err) {
        console.warn(`recordTombstones failed: ${err.message}`);
      }
    }
  }

  // Filter out any "new" ads whose externalId is still suppressed by a
  // recent tombstone. Without this guard, the merge race could push a
  // just-removed listing back into seen-ads via the next scan, before
  // the suppression window is even up.
  const tombstonesFile = loadTombstones();
  const nowMs = Date.now();
  const suppressedNewIds = [];
  const acceptedNewAds = [];
  for (const ad of newAds) {
    const entry = tombstonesFile.tombstones[ad.externalId];
    const ts = entry ? Date.parse(entry.removedAt || '') : NaN;
    if (
      entry &&
      Number.isFinite(ts) &&
      nowMs - ts < TOMBSTONE_SUPPRESS_MS
    ) {
      suppressedNewIds.push(ad.externalId);
    } else {
      acceptedNewAds.push(ad);
    }
  }
  newAds = acceptedNewAds;

  for (const ad of existingAds) {
    const existing = seen.ads[ad.externalId] || {};
    // The fresh `ad` came from the latest list-card scrape and is the
    // source of truth: we no longer fetch detail pages, so the only
    // signal we have for city/title/price/rooms is the search-page
    // card. Always prefer a clean fresh value over a stale existing
    // one (in particular, this lets us heal the records that previous
    // versions of the worker corrupted with `title: "מודעה"` /
    // `city: null` after a failed detail-page enrichment).
    const freshTitle =
      typeof ad.title === 'string' && !isPoisonString(ad.title) ? ad.title : null;
    const freshCity =
      typeof ad.city === 'string' && !isPoisonString(ad.city) && ad.city.trim()
        ? ad.city
        : null;
    const freshPrice = typeof ad.price === 'number' ? ad.price : null;
    const freshRooms = typeof ad.rooms === 'number' ? ad.rooms : null;

    // Title resolution: prefer a canonical "PROPERTY_TYPE, CITY"
    // heading whenever we have one. Only fall back to the existing
    // title when the fresh title is also low-quality, so a stored
    // "TM Agassi GROUP" / "בית פרטי/ קוטג'" / "ריח הדס 252" can be
    // replaced by a fresh canonical heading from the next scan.
    let resolvedTitle;
    if (freshTitle && isCanonicalHeading(freshTitle)) {
      resolvedTitle = freshTitle;
    } else if (existing.title && !isLowQualityTitle(existing.title)) {
      resolvedTitle = existing.title;
    } else if (freshTitle && !isLowQualityTitle(freshTitle)) {
      resolvedTitle = freshTitle;
    } else if (freshTitle) {
      // Only a low-quality fresh title is available; still prefer it
      // over an even-worse existing one (poison, placeholder).
      resolvedTitle = freshTitle;
    } else {
      resolvedTitle = existing.title || null;
    }

    seen.ads[ad.externalId] = {
      ...existing,
      externalId: ad.externalId,
      title: resolvedTitle,
      link: ad.link || existing.link,
      searchId: ad.searchId || existing.searchId,
      searchLabel: ad.searchLabel || existing.searchLabel,
      districtLabel: ad.districtLabel || existing.districtLabel,
      // City preference: fresh > existing-clean. preferFreshField only
      // overrides existing when it is missing or poison, which is
      // exactly what we want to repopulate the previously-nulled
      // records without overwriting a clean city with a transient
      // scrape blank.
      // City: trust the fresh list-card value when present and clean.
      // Previous versions sometimes wrote a street name into city via
      // a different layout; the canonical fresh value should win.
      city: freshCity ? freshCity : preferFreshField(existing.city, freshCity),
      // Same logic for price and rooms - if the latest scrape has a
      // value, accept it; otherwise keep what we had.
      price: freshPrice !== null ? freshPrice : existing.price ?? null,
      rooms: freshRooms !== null ? freshRooms : existing.rooms ?? null,
      lastSeenAt: now
    };
  }

  for (const ad of newAds) {
    seen.ads[ad.externalId] = {
      externalId: ad.externalId,
      title: ad.title,
      link: ad.link,
      searchId: ad.searchId,
      searchLabel: ad.searchLabel,
      districtLabel: ad.districtLabel,
      price: ad.price,
      rooms: ad.rooms,
      city: ad.city,
      firstSeenAt: now,
      lastSeenAt: now
    };
  }

  const pruned = pruneSeenAds(seen, env.SEEN_RETENTION_DAYS);
  saveSeenAds(pruned);

  return { removed, skippedDistricts, suppressedNewIds };
}

function saveAndDetectNewAds(ads) {
  const { newAds, existingAds } = splitNewAndExisting(ads);
  commitAds({ newAds, existingAds });
  return newAds;
}

function listRecentRuns(limit = 10) {
  const { runs } = loadRuns();
  return runs.slice(0, limit);
}

module.exports = {
  TOMBSTONE_SUPPRESS_MS,
  TOMBSTONE_RETENTION_MS,
  commitAds,
  ensureStateDir,
  isTombstonedRecently,
  listRecentRuns,
  loadSeenAds,
  loadTombstones,
  recordRun,
  recordTombstones,
  removeDeletedAds,
  saveAndDetectNewAds,
  saveSeenAds,
  saveTombstones,
  splitNewAndExisting
};
