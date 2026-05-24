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
//   - scrape-circuit.json → single global circuit-breaker record.
//     Picks the entry with the latest lastObservedAt; concurrent
//     writers with older snapshots lose. Threshold counter and
//     frozenUntil come straight from the winning side.
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

// scrape-circuit.json merge:
//   Single-record file describing the global circuit-breaker state.
//   We keep the snapshot with the latest lastObservedAt — that's the
//   freshest view of "did we just get blocked / are we currently
//   frozen". A null/missing local timestamp loses to any remote one
//   and vice-versa.
function mergeCircuit(localFile, remoteFile) {
  function ts(file) {
    if (!file || typeof file !== 'object') return 0;
    return Date.parse(file.lastObservedAt || '') || 0;
  }
  const localTs = ts(localFile);
  const remoteTs = ts(remoteFile);
  if (localTs === 0 && remoteTs === 0) {
    return localFile || remoteFile || null;
  }
  return localTs >= remoteTs ? localFile : remoteFile;
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

  const MERGED_FILES = ['seen-ads.json', 'runs.json', 'scrape-circuit.json'];

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
      const mergedCount = merged && remote && merged.runs ? merged.runs.length : 0;
      console.log(
        `[merge-state] ${filename}: local=${localCount} remote=${remoteCount} merged=${mergedCount}`
      );
    } else {
      merged = mergeCircuit(local, remote);
      const winner = !local ? 'remote' : !remote ? 'local' : merged === local ? 'local' : 'remote';
      console.log(
        `[merge-state] ${filename}: chose ${winner} snapshot (frozenUntil=${
          merged && merged.frozenUntil ? merged.frozenUntil : '—'
        }, counter=${
          merged && merged.consecutiveBlockedIterations
            ? merged.consecutiveBlockedIterations
            : 0
        })`
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
  mergeCircuit,
  mergeStateDirs
};
