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
//     lastSeenAt advances to the newest of the two. Any externalId
//     with a fresh tombstone is REMOVED from the merged set so the
//     race-safe merge doesn't silently un-delete what a worker
//     deliberately removed.
//   - runs.json → merge by startedAt, dedupe, sort newest-first, cap
//     to HISTORY_LIMIT.
//   - tombstones.json → UNION of local ∪ remote tombstones, retaining
//     the more recent removedAt for ids that appear in both. Old
//     entries past TOMBSTONE_RETENTION_MS are pruned so the file
//     stays bounded.
//   - Any other JSON file → prefer the local copy.

const fs = require('fs');
const path = require('path');

const HISTORY_LIMIT = 50;
const TOMBSTONE_SUPPRESS_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

function mergeSeenAds(localFile, remoteFile, mergedTombstones = { tombstones: {} }, now = Date.now()) {
  const localAds = (localFile && typeof localFile === 'object' && localFile.ads) || {};
  const remoteAds = (remoteFile && typeof remoteFile === 'object' && remoteFile.ads) || {};

  const tombstones = mergedTombstones?.tombstones || {};
  function isSuppressed(externalId) {
    const entry = tombstones[externalId];
    if (!entry) return false;
    const ts = Date.parse(entry.removedAt || '');
    if (!Number.isFinite(ts)) return false;
    return now - ts < TOMBSTONE_SUPPRESS_MS;
  }

  const mergedAds = {};
  const allKeys = new Set([...Object.keys(remoteAds), ...Object.keys(localAds)]);

  let suppressedCount = 0;
  for (const key of allKeys) {
    if (isSuppressed(key)) {
      suppressedCount += 1;
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

  if (suppressedCount) {
    console.log(`[merge-state] tombstones suppressed ${suppressedCount} keys from merged seen-ads`);
  }

  return {
    ...(remoteFile || {}),
    ...(localFile || {}),
    ads: mergedAds
  };
}

function mergeTombstones(localFile, remoteFile, now = Date.now()) {
  const local = (localFile && typeof localFile === 'object' && localFile.tombstones) || {};
  const remote = (remoteFile && typeof remoteFile === 'object' && remoteFile.tombstones) || {};

  const merged = {};
  const allKeys = new Set([...Object.keys(remote), ...Object.keys(local)]);
  const cutoff = now - TOMBSTONE_RETENTION_MS;

  for (const key of allKeys) {
    const r = remote[key];
    const l = local[key];
    let chosen;
    if (r && l) {
      const lTs = Date.parse(l.removedAt || '') || 0;
      const rTs = Date.parse(r.removedAt || '') || 0;
      chosen = lTs >= rTs ? l : r;
    } else {
      chosen = r || l;
    }
    if (!chosen) continue;
    const ts = Date.parse(chosen.removedAt || '');
    if (Number.isFinite(ts) && ts < cutoff) continue; // pruned
    merged[key] = chosen;
  }

  return {
    ...(remoteFile || {}),
    ...(localFile || {}),
    tombstones: merged
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

function mergeStateDirs(stateDir, workDir) {
  // Tombstones are merged first so seen-ads can consult them when
  // deciding which keys to keep in the merged file.
  const tombstoneLocal = readJsonSafe(path.join(stateDir, 'tombstones.json'));
  const tombstoneRemote = readJsonSafe(path.join(workDir, 'tombstones.json'));
  const mergedTombstones = mergeTombstones(tombstoneLocal, tombstoneRemote);
  if (tombstoneLocal || tombstoneRemote) {
    const localCount = tombstoneLocal?.tombstones
      ? Object.keys(tombstoneLocal.tombstones).length
      : 0;
    const remoteCount = tombstoneRemote?.tombstones
      ? Object.keys(tombstoneRemote.tombstones).length
      : 0;
    const mergedCount = Object.keys(mergedTombstones.tombstones || {}).length;
    console.log(
      `[merge-state] tombstones.json: local=${localCount} remote=${remoteCount} merged=${mergedCount}`
    );
    writeJsonPretty(path.join(workDir, 'tombstones.json'), mergedTombstones);
  }

  for (const filename of ['seen-ads.json', 'runs.json']) {
    const localPath = path.join(stateDir, filename);
    const remotePath = path.join(workDir, filename);
    const local = readJsonSafe(localPath);
    const remote = readJsonSafe(remotePath);

    if (local === null && remote === null) continue;

    let merged;
    if (filename === 'seen-ads.json') {
      merged = mergeSeenAds(local, remote, mergedTombstones);
      const localCount = local && local.ads ? Object.keys(local.ads).length : 0;
      const remoteCount = remote && remote.ads ? Object.keys(remote.ads).length : 0;
      const mergedCount = merged && merged.ads ? Object.keys(merged.ads).length : 0;
      console.log(
        `[merge-state] ${filename}: local=${localCount} remote=${remoteCount} merged=${mergedCount}`
      );
    } else {
      merged = mergeRuns(local, remote);
      const localCount = local && local.runs ? local.runs.length : 0;
      const remoteCount = remote && remote.runs ? remote.runs.length : 0;
      const mergedCount = merged && merged.runs ? merged.runs.length : 0;
      console.log(
        `[merge-state] ${filename}: local=${localCount} remote=${remoteCount} merged=${mergedCount}`
      );
    }

    writeJsonPretty(remotePath, merged);
  }

  // Copy any other state files present locally (future-proofing).
  for (const entry of fs.readdirSync(stateDir)) {
    if (entry === 'seen-ads.json' || entry === 'runs.json' || entry === 'tombstones.json') continue;
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
  TOMBSTONE_RETENTION_MS,
  TOMBSTONE_SUPPRESS_MS,
  mergeSeenAds,
  mergeRuns,
  mergeStateDirs,
  mergeTombstones
};
