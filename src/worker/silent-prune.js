const { env } = require('../config/env');
const {
  ensureStateDir,
  loadSeenAds,
  saveSeenAds
} = require('../store/file-store');
const { probeListingsPresence } = require('../scraper/yad2');

// What searchIds this worker is allowed to delete from. Defaults to
// rent-in-cities only; we read it from the workflow env so a future
// watch can opt in without touching the worker code. The set is
// deliberately scoped so the worker is structurally incapable of
// removing a moshav or Lev HaPark record.
const DEFAULT_TARGET_SEARCH_IDS = ['rent-in-cities'];
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 12000;

function parseIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveTargetSearchIds(raw) {
  const parsed = parseIdList(raw);
  return parsed.length ? parsed : DEFAULT_TARGET_SEARCH_IDS.slice();
}

// Pure: which seen-records this worker is allowed to probe + delete.
// Only ads whose searchId is in `targetSearchIds` and that have a
// non-empty link (the probe URL) qualify. Everything else — moshav,
// lev-hapark, malformed entries — is silently passed over.
function pickPruneTargets(seen, targetSearchIds) {
  const allowed = new Set(targetSearchIds || []);
  const targets = [];
  for (const record of Object.values((seen && seen.ads) || {})) {
    if (!record || !record.externalId) continue;
    if (!allowed.has(record.searchId)) continue;
    if (typeof record.link !== 'string' || !record.link.trim()) continue;
    targets.push(record);
  }
  return targets;
}

// Pure: given the probe outcomes (keyed by URL), decide which records
// to delete. We delete ONLY on an explicit `removed` verdict. `live`,
// `blocked` (anti-bot), `error`, or missing-probe are all "keep" —
// which is what guarantees an anti-bot blank can't wipe the page.
function classifyForRemoval(targets, probeResultsByUrl) {
  const byUrl =
    probeResultsByUrl instanceof Map
      ? probeResultsByUrl
      : new Map(
          (probeResultsByUrl || []).map((r) => [r && r.url, r]).filter(([k]) => k)
        );
  const toRemove = [];
  for (const record of targets || []) {
    const probe = byUrl.get(record.link);
    if (probe && probe.status === 'removed') {
      toRemove.push({
        externalId: record.externalId,
        searchId: record.searchId,
        link: record.link,
        title: record.title || null,
        reason: probe.reason || `HTTP ${probe.httpStatus || 'unknown'}`
      });
    }
  }
  return toRemove;
}

// Pure: produce the updated seen object after subtracting the
// to-be-deleted externalIds. Caller decides whether to persist.
function applyRemovals(seen, toRemove) {
  if (!toRemove || !toRemove.length) {
    return { seen, removedIds: [] };
  }
  const next = { ...seen, ads: { ...((seen && seen.ads) || {}) } };
  const removedIds = [];
  for (const entry of toRemove) {
    if (!entry || !entry.externalId) continue;
    if (next.ads[entry.externalId]) {
      delete next.ads[entry.externalId];
      removedIds.push(entry.externalId);
    }
  }
  return { seen: next, removedIds };
}

async function runSilentPrune({
  targetSearchIds = DEFAULT_TARGET_SEARCH_IDS,
  headless = true,
  concurrency = PROBE_CONCURRENCY,
  timeoutMs = PROBE_TIMEOUT_MS
} = {}) {
  ensureStateDir();
  const seen = loadSeenAds();
  const targets = pickPruneTargets(seen, targetSearchIds);
  if (!targets.length) {
    return {
      targetSearchIds,
      probed: 0,
      probeResults: [],
      removed: [],
      keptByStatus: {}
    };
  }

  const urls = targets.map((r) => r.link);
  const probeResults = await probeListingsPresence({
    urls,
    headless,
    timeoutMs,
    concurrency
  });

  const byUrl = new Map();
  for (const result of probeResults) {
    if (result && result.url) byUrl.set(result.url, result);
  }

  const toRemove = classifyForRemoval(targets, byUrl);
  const { seen: nextSeen, removedIds } = applyRemovals(seen, toRemove);
  if (removedIds.length) {
    saveSeenAds(nextSeen);
  }

  // Summary stats for the workflow log only - never sent to telegram/email.
  const keptByStatus = { live: 0, blocked: 0, error: 0, unknown: 0 };
  for (const target of targets) {
    const probe = byUrl.get(target.link);
    const status = probe && probe.status ? probe.status : 'unknown';
    if (status === 'removed') continue;
    keptByStatus[status] = (keptByStatus[status] || 0) + 1;
  }

  return {
    targetSearchIds,
    probed: targets.length,
    probeResults,
    removed: toRemove,
    keptByStatus
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const targetSearchIds = resolveTargetSearchIds(process.env.PRUNE_TARGET_SEARCH_IDS);
  try {
    const result = await runSilentPrune({
      targetSearchIds,
      headless: env.PLAYWRIGHT_HEADLESS
    });

    // Hand the deletions to the persist step so the merge subtracts
    // these keys from the union with origin/state - identical to the
    // pattern used by run-once.js for its silent self-prune. Without
    // this, a concurrent scan that fetched seen-ads.json *before* we
    // wrote our deletion would resurrect every id we just removed.
    if (process.env.GITHUB_ENV) {
      const removedIds = result.removed
        .map((r) => r && r.externalId)
        .filter(Boolean);
      if (removedIds.length > 0) {
        try {
          const fs = require('fs');
          fs.appendFileSync(
            process.env.GITHUB_ENV,
            `SEEN_ADS_FORCE_DELETE_IDS=${removedIds.join(',')}\n`
          );
        } catch (err) {
          console.warn(
            `[silent-prune] could not write SEEN_ADS_FORCE_DELETE_IDS to GITHUB_ENV: ${err.message}`
          );
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          kind: 'silent-prune',
          startedAt,
          completedAt: new Date().toISOString(),
          targetSearchIds: result.targetSearchIds,
          probed: result.probed,
          removed: result.removed,
          keptByStatus: result.keptByStatus
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error('[silent-prune] failed:', error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  applyRemovals,
  classifyForRemoval,
  pickPruneTargets,
  resolveTargetSearchIds,
  runSilentPrune
};
