const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const SEEN_FILE = 'seen-ads.json';
const RUNS_FILE = 'runs.json';

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

function removeDeletedAds(seen, scrapedAds = [], scrapedSearchIds = []) {
  const successfulSearchIds = new Set(scrapedSearchIds);
  if (!successfulSearchIds.size) {
    return { seen, removed: [] };
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

  const removed = [];
  const ads = { ...(seen.ads || {}) };
  for (const [externalId, record] of Object.entries(ads)) {
    if (!record || !successfulSearchIds.has(record.searchId)) continue;
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

  return { seen: { ...seen, ads }, removed };
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

  if (Array.isArray(allScrapedAds) && Array.isArray(scrapedSearchIds)) {
    const result = removeDeletedAds(seen, allScrapedAds, scrapedSearchIds);
    seen = result.seen;
    removed = result.removed;
  }

  for (const ad of existingAds) {
    const existing = seen.ads[ad.externalId];
    seen.ads[ad.externalId] = {
      ...(existing || {}),
      externalId: ad.externalId,
      title: ad.title,
      link: ad.link,
      searchId: ad.searchId,
      searchLabel: ad.searchLabel,
      districtLabel: ad.districtLabel,
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

  return { removed };
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
  commitAds,
  ensureStateDir,
  listRecentRuns,
  loadSeenAds,
  recordRun,
  removeDeletedAds,
  saveAndDetectNewAds,
  splitNewAndExisting
};
