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
//   - runs.json → merge by startedAt, dedupe, sort newest-first, cap
//     to HISTORY_LIMIT.
//   - Any other JSON file → prefer the local copy.
//
// We deliberately do NOT honour deletes here. removeDeletedAds in the
// worker has its own anti-bot safeguards; if it really did remove an
// ad, the next clean scrape will remove it again. Worst case: a deleted
// ad lingers one iteration. Best case: we never wipe a freshly-added
// ad just because two workflows raced.

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

function mergeSeenAds(localFile, remoteFile) {
  const localAds = (localFile && typeof localFile === 'object' && localFile.ads) || {};
  const remoteAds = (remoteFile && typeof remoteFile === 'object' && remoteFile.ads) || {};

  const mergedAds = {};
  const allKeys = new Set([...Object.keys(remoteAds), ...Object.keys(localAds)]);

  for (const key of allKeys) {
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

  return {
    ...(remoteFile || {}),
    ...(localFile || {}),
    ads: mergedAds
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
  for (const filename of ['seen-ads.json', 'runs.json']) {
    const localPath = path.join(stateDir, filename);
    const remotePath = path.join(workDir, filename);
    const local = readJsonSafe(localPath);
    const remote = readJsonSafe(remotePath);

    if (local === null && remote === null) continue;

    let merged;
    if (filename === 'seen-ads.json') {
      merged = mergeSeenAds(local, remote);
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
    if (entry === 'seen-ads.json' || entry === 'runs.json') continue;
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
  mergeStateDirs
};
