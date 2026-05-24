#!/usr/bin/env node
'use strict';

// Race-safe merge: combines our local STATE_DIR snapshot with whatever
// is currently on the `state` branch (already checked out into WORK_DIR).
// Writes the merged result back into WORK_DIR so persist-state.sh can
// commit and push it.
//
// Strategy:
//   - seen-ads.json → UNION of local ∪ remote, preferring local fields
//     for keys that exist in both. firstSeenAt never regresses;
//     lastSeenAt advances to the newest of the two.
//
//     A worker that deliberately deleted keys can pass that intent in
//     via the SEEN_ADS_FORCE_DELETE_IDS env var (comma-separated). The
//     merge will subtract those keys from the union so that a
//     concurrent scan's earlier remote snapshot can't resurrect them.
//     Only the health-check sets this — the scan is additive only.
//   - runs.json → merge by startedAt, dedupe, sort newest-first, cap
//     to HISTORY_LIMIT.
//   - scrape-cooldowns.json → per-searchId merge picking the LATER of
//     local vs remote observation (observedAt / cleared marker). Lets
//     one worker's "blocked" survive a concurrent writer's older
//     "ok" snapshot, and vice-versa.
//   - Any other JSON file → prefer the local copy.

const fs = require('fs');
const path = require('path');

const HISTORY_LIMIT = 50;

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[merge-state] could not parse ${filePath}: ${err.message}`);
    return null;
  }
}

function writeJsonPretty(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function pickEarlier(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function pickLater(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function mergeSeenAds(localFile, remoteFile, forceDeleteIds = []) {
  const localAds = (localFile && typeof localFile === 'object' && localFile.ads) || {};
  const remoteAds = (remoteFile && typeof remoteFile === 'object' && remoteFile.ads) || {};

  const forceDelete = new Set(
    Array.isArray(forceDeleteIds) ? forceDeleteIds.filter(Boolean) : []
  );

  const mergedAds = {};
  const allKeys = new Set([...Object.keys(remoteAds), ...Object.keys(localAds)]);

  let forceDeletedCount = 0;
  for (const key of allKeys) {
    if (forceDelete.has(key)) {
      forceDeletedCount += 1;
      continue;
    }
    const remote = remoteAds[key];
    const local = localAds[key];
    if (!remote && local) {
      mergedAds[key] = local;
      continue;
    }
    if (remote && !local) {
      mergedAds[key] = remote;
      continue;
    }
    mergedAds[key] = {
      ...remote,
      ...local,
      firstSeenAt: pickEarlier(local.firstSeenAt, remote.firstSeenAt),
      lastSeenAt: pickLater(local.lastSeenAt, remote.lastSeenAt)
    };
  }

  if (forceDeletedCount) {
    console.log(
      `[merge-state] subtracted ${forceDeletedCount} forced-delete id(s) from merged seen-ads`
    );
  }

  return {
    ...(remoteFile || {}),
    ...(localFile || {}),
    ads: mergedAds
  };
}

// scrape-cooldowns.json merge:
//   For each searchId in (local.entries ∪ remote.entries), keep the
//   entry with the latest observedAt. A "cleared" marker on either
//   side (state.cleared[id]) is treated as an observation at that
//   timestamp; if it's newer than the matching entry, the cooldown
//   for that search is dropped.
//
// Result shape: { entries: { … }, cleared: { … } }
function mergeCooldowns(localFile, remoteFile) {
  const localEntries =
    (localFile && typeof localFile === 'object' && localFile.entries) || {};
  const remoteEntries =
    (remoteFile && typeof remoteFile === 'object' && remoteFile.entries) || {};
  const localCleared =
    (localFile && typeof localFile === 'object' && localFile.cleared) || {};
  const remoteCleared =
    (remoteFile && typeof remoteFile === 'object' && remoteFile.cleared) || {};

  function entryObservedAt(entry) {
    if (!entry) return 0;
    return Date.parse(entry.observedAt || entry.blockedAt || '') || 0;
  }
  function clearedAt(map, id) {
    if (!map || !map[id]) return 0;
    return Date.parse(map[id] || '') || 0;
  }

  const allIds = new Set([
    ...Object.keys(localEntries),
    ...Object.keys(remoteEntries),
    ...Object.keys(localCleared),
    ...Object.keys(remoteCleared)
  ]);

  const mergedEntries = {};
  const mergedCleared = {};

  for (const id of allIds) {
    const local = localEntries[id] || null;
    const remote = remoteEntries[id] || null;
    const localClear = clearedAt(localCleared, id);
    const remoteClear = clearedAt(remoteCleared, id);
    const latestClear = Math.max(localClear, remoteClear);
    const latestClearIso =
      latestClear > 0 ? new Date(latestClear).toISOString() : null;

    if (latestClearIso) mergedCleared[id] = latestClearIso;

    const localObs = entryObservedAt(local);
    const remoteObs = entryObservedAt(remote);
    const latestEntry = localObs >= remoteObs ? local : remote;
    const latestEntryObs = Math.max(localObs, remoteObs);

    if (latestEntry && latestEntryObs > latestClear) {
      mergedEntries[id] = latestEntry;
    }
  }

  return {
    ...(remoteFile || {}),
    ...(localFile || {}),
    entries: mergedEntries,
    cleared: mergedCleared
  };
}

function mergeRuns(localFile, remoteFile) {
  const local = Array.isArray(localFile && localFile.runs) ? localFile.runs : [];
  const remote = Array.isArray(remoteFile && remoteFile.runs) ? remoteFile.runs : [];

  const map = new Map();
  for (const run of remote) {
    if (run && run.startedAt) map.set(run.startedAt, run);
  }
  // Local runs win on tie because they were just recorded by the same
  // process that's about to push.
  for (const run of local) {
    if (run && run.startedAt) map.set(run.startedAt, run);
  }

  const merged = Array.from(map.values()).sort((a, b) => {
    const aTime = Date.parse(a.startedAt || '') || 0;
    const bTime = Date.parse(b.startedAt || '') || 0;
    return bTime - aTime;
  });

  return {
    ...(remoteFile || {}),
    ...(localFile || {}),
    runs: merged.slice(0, HISTORY_LIMIT)
  };
}

function parseForceDeleteIds(envValue) {
  if (!envValue || typeof envValue !== 'string') return [];
  return envValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergeStateDirs(stateDir, workDir, options = {}) {
  const forceDeleteIds = options.forceDeleteIds
    ? options.forceDeleteIds
    : parseForceDeleteIds(process.env.SEEN_ADS_FORCE_DELETE_IDS || '');
  if (forceDeleteIds.length) {
    console.log(
      `[merge-state] SEEN_ADS_FORCE_DELETE_IDS supplied ${forceDeleteIds.length} id(s) to subtract`
    );
  }

  const MERGED_FILES = ['seen-ads.json', 'runs.json', 'scrape-cooldowns.json'];

  for (const filename of MERGED_FILES) {
    const localPath = path.join(stateDir, filename);
    const remotePath = path.join(workDir, filename);
    const local = readJsonSafe(localPath);
    const remote = readJsonSafe(remotePath);

    if (local === null && remote === null) continue;

    let merged;
    if (filename === 'seen-ads.json') {
      merged = mergeSeenAds(local, remote, forceDeleteIds);
      const localCount = local && local.ads ? Object.keys(local.ads).length : 0;
      const remoteCount = remote && remote.ads ? Object.keys(remote.ads).length : 0;
      const mergedCount = merged && merged.ads ? Object.keys(merged.ads).length : 0;
      console.log(
        `[merge-state] ${filename}: local=${localCount} remote=${remoteCount} merged=${mergedCount}`
      );
    } else if (filename === 'runs.json') {
      merged = mergeRuns(local, remote);
      const localCount = local && local.runs ? local.runs.length : 0;
      const remoteCount = remote && remote.runs ? remote.runs.length : 0;
      const mergedCount = merged && merged.runs ? merged.runs.length : 0;
      console.log(
        `[merge-state] ${filename}: local=${localCount} remote=${remoteCount} merged=${mergedCount}`
      );
    } else {
      merged = mergeCooldowns(local, remote);
      const localCount = local && local.entries ? Object.keys(local.entries).length : 0;
      const remoteCount = remote && remote.entries ? Object.keys(remote.entries).length : 0;
      const mergedCount = merged && merged.entries ? Object.keys(merged.entries).length : 0;
      console.log(
        `[merge-state] ${filename}: local=${localCount} remote=${remoteCount} merged=${mergedCount}`
      );
    }

    writeJsonPretty(remotePath, merged);
  }

  // Copy any other state files present locally (future-proofing).
  for (const entry of fs.readdirSync(stateDir)) {
    if (MERGED_FILES.includes(entry)) continue;
    const src = path.join(stateDir, entry);
    if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(workDir, entry);
    fs.copyFileSync(src, dst);
    console.log(`[merge-state] copied passthrough file ${entry}`);
  }
}

if (require.main === module) {
  const [, , STATE_DIR, WORK_DIR] = process.argv;
  if (!STATE_DIR || !WORK_DIR) {
    console.error('[merge-state] usage: merge-state.js <STATE_DIR> <WORK_DIR>');
    process.exit(2);
  }
  mergeStateDirs(STATE_DIR, WORK_DIR);
}

module.exports = {
  HISTORY_LIMIT,
  mergeSeenAds,
  mergeRuns,
  mergeCooldowns,
  mergeStateDirs
};
