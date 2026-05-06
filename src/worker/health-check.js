const { spawnSync } = require('child_process');
const path = require('path');
const { env } = require('../config/env');
const {
  buildFilterLimitsMap,
  getEnabledSearches
} = require('../config/searches');
const {
  ensureStateDir,
  loadSeenAds,
  recordRun,
  saveSeenAds
} = require('../store/file-store');
const {
  probeListingsPresence,
  scrapeAllSearches
} = require('../scraper/yad2');
const { filterRelevantAds } = require('../services/relevance');
const { sendHealthCheckReport } = require('../services/telegram');

const RECONCILE_PROBE_TIMEOUT_MS = 12000;
const RECONCILE_PROBE_CONCURRENCY = 4;

function refreshStateFromBranch() {
  // Pull whatever the looping scan has just pushed to the `state` branch.
  // Done both before and after the scrape to minimise the racing window.
  const stateDir = env.STATE_DIR;
  if (!stateDir) return false;
  if (!process.env.GITHUB_ACTIONS) return false;

  const repoRoot = path.resolve(__dirname, '..', '..');
  const fetchResult = spawnSync(
    'git',
    ['fetch', '--depth=1', 'origin', 'state'],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (fetchResult.status !== 0) {
    console.warn('[health-check] could not fetch origin/state; using stale seen-set');
    return false;
  }
  const checkoutResult = spawnSync(
    'git',
    [`--work-tree=${stateDir}`, 'checkout', 'origin/state', '--', '.'],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (checkoutResult.status !== 0) {
    console.warn('[health-check] could not checkout origin/state into state dir');
    return false;
  }
  return true;
}

function persistStateToBranch({ forceDeleteIds = [] } = {}) {
  if (!process.env.GITHUB_ACTIONS) {
    return { ok: false, reason: 'not running in GitHub Actions' };
  }
  const repoRoot = path.resolve(__dirname, '..', '..');
  const script = path.resolve(repoRoot, 'scripts', 'persist-state.sh');
  // The merge step (scripts/merge-state.js) reads
  // SEEN_ADS_FORCE_DELETE_IDS to subtract specific keys from the
  // merged seen-ads.json. Without this hint the merge would
  // re-introduce a key we just deleted whenever the remote (fetched
  // before our deletion landed) still has it - exactly the bug that
  // caused ads to be repeatedly re-announced as "new".
  const env = { ...process.env };
  if (Array.isArray(forceDeleteIds) && forceDeleteIds.length) {
    env.SEEN_ADS_FORCE_DELETE_IDS = forceDeleteIds.join(',');
  } else {
    delete env.SEEN_ADS_FORCE_DELETE_IDS;
  }
  const result = spawnSync('bash', [script], {
    cwd: repoRoot,
    stdio: 'inherit',
    env
  });
  if (result.status !== 0) {
    return { ok: false, reason: `persist-state.sh exited with ${result.status}` };
  }
  return { ok: true };
}

function buildExpectedBySearchId(seen) {
  const result = {};
  for (const record of Object.values(seen.ads || {})) {
    const id = record.searchId;
    if (!id) continue;
    if (!result[id]) {
      result[id] = { count: 0, ids: new Set() };
    }
    result[id].count += 1;
    if (record.externalId) {
      result[id].ids.add(record.externalId);
    }
  }
  return result;
}

function deriveRealForSearch(scrapedAds, search) {
  const districtAds = scrapedAds.filter((ad) => ad.searchId === search.id);
  const scrapedIds = new Set(districtAds.map((ad) => ad.externalId).filter(Boolean));

  if (!districtAds.length) {
    return { real: 0, headerCount: null, scrapedIds };
  }

  const headerCount = districtAds.find(
    (ad) => typeof ad.expectedCount === 'number'
  )?.expectedCount;

  if (typeof headerCount === 'number') {
    return { real: headerCount, headerCount, scrapedIds };
  }

  return { real: districtAds.length, headerCount: null, scrapedIds };
}

function externalIdToLink(externalId) {
  if (!externalId) return null;
  return `https://www.yad2.co.il/realestate/item/${externalId}`;
}

function buildExtraEntries(rows, seen) {
  // For each extraId (in seen but not in latest scrape), pull the seen
  // record so we can ask Yad2 directly whether the ad still exists.
  const entries = [];
  for (const row of rows) {
    if (!Array.isArray(row.extraIds)) continue;
    for (const externalId of row.extraIds) {
      const record = (seen.ads || {})[externalId];
      const link =
        (record && record.link) || externalIdToLink(externalId);
      entries.push({ externalId, searchId: row.searchId, link, record });
    }
  }
  return entries;
}

function buildMissingEntries(rows, scrapedAds) {
  // For each missingId (live but not in seen), pull the scraped record
  // so we can enrich + admit it into seen.
  const adsById = new Map();
  for (const ad of scrapedAds) {
    if (ad && ad.externalId) {
      adsById.set(ad.externalId, ad);
    }
  }
  const entries = [];
  for (const row of rows) {
    if (!Array.isArray(row.missingIds)) continue;
    for (const externalId of row.missingIds) {
      const ad = adsById.get(externalId);
      if (ad) entries.push({ externalId, searchId: row.searchId, ad });
    }
  }
  return entries;
}

async function classifyExtraEntries(extraEntries, { headless }) {
  if (!extraEntries.length) return new Map();
  const urls = extraEntries
    .map((entry) => entry.link)
    .filter((link) => typeof link === 'string' && link.length);
  if (!urls.length) return new Map();

  const probeResults = await probeListingsPresence({
    urls,
    headless,
    timeoutMs: RECONCILE_PROBE_TIMEOUT_MS,
    concurrency: RECONCILE_PROBE_CONCURRENCY
  });

  const byUrl = new Map();
  for (const result of probeResults) {
    byUrl.set(result.url, result);
  }
  return byUrl;
}

// We no longer enrich missing ads via the detail page. The list-card
// scrape that produced `entry.ad` already carries title / city /
// rooms / price / district / link - everything the dashboard renders.
// Detail-page enrichment was the source of most "מחיר לא מצוין" /
// "מודעה" leakage on the dashboard, because Yad2 anti-bot blocks the
// majority of detail-page GETs from GitHub Actions.
function buildMissingFromListCards(missingEntries) {
  const byId = new Map();
  for (const entry of missingEntries) {
    if (entry && entry.externalId && entry.ad) {
      byId.set(entry.externalId, entry.ad);
    }
  }
  return byId;
}

function adRecordFromEnriched(enriched, { searchId, label, generatedAt }) {
  // Mirror the shape produced by store/file-store.js#commitAds so the
  // dashboard renderer doesn't need to know we got here via reconciliation.
  return {
    externalId: enriched.externalId,
    title: enriched.title || null,
    link: enriched.link,
    searchId,
    searchLabel: enriched.searchLabel || label || null,
    districtLabel: enriched.districtLabel || label || null,
    price: typeof enriched.price === 'number' ? enriched.price : null,
    rooms: typeof enriched.rooms === 'number' ? enriched.rooms : null,
    city: enriched.city || null,
    firstSeenAt: generatedAt,
    lastSeenAt: generatedAt
  };
}

// Decide whether a live but feed-missing ad still satisfies the
// search's URL filters (maxPrice, minRooms). We prefer the values
// the live probe just observed; if those are missing we fall back
// to whatever we stored in seen at admission time. Returns either:
//   { kind: 'pass' }                                  → keep as unresolved-extra
//   { kind: 'fail', reason: 'price raised to ...', ... } → retire it
function evaluateExtraAgainstFilters({ probe, record, limits }) {
  if (!limits) return { kind: 'pass' };

  const probePrice = probe && typeof probe.price === 'number' ? probe.price : null;
  const probeRooms = probe && typeof probe.rooms === 'number' ? probe.rooms : null;
  const seenPrice = record && typeof record.price === 'number' ? record.price : null;
  const seenRooms = record && typeof record.rooms === 'number' ? record.rooms : null;

  const effectivePrice = probePrice ?? seenPrice;
  const effectiveRooms = probeRooms ?? seenRooms;

  if (
    typeof limits.maxPrice === 'number' &&
    typeof effectivePrice === 'number' &&
    effectivePrice > limits.maxPrice
  ) {
    const formatted = effectivePrice.toLocaleString('he-IL');
    const cap = limits.maxPrice.toLocaleString('he-IL');
    return {
      kind: 'fail',
      reason: `המחיר עודכן ל-${formatted} ₪ (מעבר לתקרה ${cap} ₪) — הוסרה`
    };
  }
  if (
    typeof limits.minRooms === 'number' &&
    typeof effectiveRooms === 'number' &&
    effectiveRooms < limits.minRooms
  ) {
    return {
      kind: 'fail',
      reason: `מספר החדרים עודכן ל-${effectiveRooms} (מתחת ל-${limits.minRooms}) — הוסרה`
    };
  }

  return { kind: 'pass' };
}

function reconcileSeen({
  rows,
  seen,
  extraClassification,
  missingClassification,
  generatedAt,
  searchById,
  filterLimitsBySearchId = new Map()
}) {
  const updatedSeen = { ...seen, ads: { ...(seen.ads || {}) } };
  const additions = [];
  const removals = [];
  const unresolvedExtras = [];
  const unresolvedMissing = [];

  for (const row of rows) {
    const search = searchById.get(row.searchId) || {
      id: row.searchId,
      label: row.label
    };

    const rowExtras = Array.isArray(row.extraIds) ? row.extraIds : [];
    for (const externalId of rowExtras) {
      const record = updatedSeen.ads[externalId];
      const link = (record && record.link) || externalIdToLink(externalId);
      const probe = link ? extraClassification.get(link) : null;

      if (probe && probe.status === 'removed') {
        delete updatedSeen.ads[externalId];
        removals.push({
          externalId,
          link,
          searchId: row.searchId,
          reason: probe.reason || 'הוסרה מ-Yad2'
        });
        continue;
      }

      // The listing is alive (or undecided). Before parking it in
      // unresolved-extras we check whether it still satisfies the
      // search's filters — an ad whose price was raised above
      // maxPrice will keep showing up here forever otherwise, even
      // though it should clearly be retired.
      if (probe && probe.status === 'live') {
        const limits = filterLimitsBySearchId.get(row.searchId) || null;
        const verdict = evaluateExtraAgainstFilters({ probe, record, limits });
        if (verdict.kind === 'fail') {
          delete updatedSeen.ads[externalId];
          removals.push({
            externalId,
            link,
            searchId: row.searchId,
            reason: verdict.reason
          });
          continue;
        }
      }

      unresolvedExtras.push({
        externalId,
        link,
        searchId: row.searchId,
        status: probe ? probe.status : 'unknown',
        reason:
          (probe && probe.reason) ||
          (probe && probe.status === 'live'
            ? 'קיימת ב-Yad2 (לינק עובד) אך לא הופיעה בסריקת המחוז — נשמרת ונבדק שוב'
            : 'לא נמצאה ב-Yad2 בסריקה האחרונה — נשמרת בינתיים, נבדק שוב בריצה הבאה')
      });
    }

    const rowMissing = Array.isArray(row.missingIds) ? row.missingIds : [];
    for (const externalId of rowMissing) {
      const classification = missingClassification.get(externalId);
      if (!classification) {
        unresolvedMissing.push({
          externalId,
          searchId: row.searchId,
          link: externalIdToLink(externalId),
          reason: 'לא נמצאה ברשומות הסריקה החיה'
        });
        continue;
      }
      if (classification.kind === 'admit') {
        const newRecord = adRecordFromEnriched(classification.enriched, {
          searchId: row.searchId,
          label: search.districtLabel || row.label,
          generatedAt
        });
        updatedSeen.ads[newRecord.externalId] = newRecord;
        additions.push({
          externalId: newRecord.externalId,
          link: newRecord.link,
          searchId: row.searchId,
          reason: 'מודעה חדשה שטרם נסרקה — נוספה ל-seen'
        });
      } else {
        unresolvedMissing.push({
          externalId,
          searchId: row.searchId,
          link: externalIdToLink(externalId),
          reason: classification.reason
        });
      }
    }
  }

  return { updatedSeen, additions, removals, unresolvedExtras, unresolvedMissing };
}

function annotateRowsWithReconciliation(
  rows,
  { additions, removals, unresolvedExtras, unresolvedMissing }
) {
  const additionsBySearch = groupBy(additions, 'searchId');
  const removalsBySearch = groupBy(removals, 'searchId');
  const unresolvedExtrasBySearch = groupBy(unresolvedExtras, 'searchId');
  const unresolvedMissingBySearch = groupBy(unresolvedMissing, 'searchId');

  return rows.map((row) => ({
    ...row,
    reconciled: {
      added: additionsBySearch[row.searchId] || [],
      removed: removalsBySearch[row.searchId] || [],
      unresolvedExtra: unresolvedExtrasBySearch[row.searchId] || [],
      unresolvedMissing: unresolvedMissingBySearch[row.searchId] || []
    }
  }));
}

function groupBy(list, key) {
  const result = {};
  for (const item of list || []) {
    const k = item && item[key];
    if (!k) continue;
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}

async function runHealthCheck() {
  ensureStateDir();

  const searches = getEnabledSearches(env.ENABLED_SEARCH_IDS);
  const searchById = new Map(searches.map((s) => [s.id, s]));
  const filterLimitsBySearchId = buildFilterLimitsMap(searches);
  const scrapeResult = await scrapeAllSearches({
    searches,
    headless: env.PLAYWRIGHT_HEADLESS,
    timeoutMs: env.SEARCH_TIMEOUT_MS
  });

  // The looping scan can push to the `state` branch while we are scraping.
  // Re-pull it so any ad it added during our scrape window is reflected
  // in the seen-set we diff against (otherwise we'd raise false-positive
  // "diff" rows on freshly-recorded ads).
  refreshStateFromBranch();

  const seenInitial = loadSeenAds();
  const expectedBySearchId = buildExpectedBySearchId(seenInitial);
  const errorBySearchId = new Map(
    (scrapeResult.errors || []).map((err) => [err.searchId, err])
  );

  const rows = searches.map((search) => {
    const expectedEntry = expectedBySearchId[search.id] || { count: 0, ids: new Set() };
    const expected = expectedEntry.count;
    const seenIds = expectedEntry.ids;
    const error = errorBySearchId.get(search.id) || null;

    if (error && (!scrapeResult.ads || !scrapeResult.ads.some((ad) => ad.searchId === search.id))) {
      return {
        searchId: search.id,
        label: search.label,
        real: null,
        expected,
        scrapedIds: [],
        seenIds: [...seenIds],
        missingIds: [],
        extraIds: [],
        error: error.message
      };
    }

    const { real, headerCount, scrapedIds } = deriveRealForSearch(
      scrapeResult.ads,
      search
    );

    const missingIds = [...scrapedIds].filter((id) => !seenIds.has(id));
    const extraIds = [...seenIds].filter((id) => !scrapedIds.has(id));

    return {
      searchId: search.id,
      label: search.label,
      real,
      expected,
      headerCount,
      scrapedIds: [...scrapedIds],
      seenIds: [...seenIds],
      missingIds,
      extraIds,
      error: null
    };
  });

  const generatedAt = new Date().toISOString();
  const extraEntries = buildExtraEntries(rows, seenInitial);
  const missingEntries = buildMissingEntries(rows, scrapeResult.ads);

  const headless = env.PLAYWRIGHT_HEADLESS;
  // We only probe the EXTRA ids (in seen but missing from latest scrape)
  // because that needs a real http call to decide whether the listing
  // was removed. MISSING ids (live on Yad2 but not yet in seen) just
  // reuse the list-card data we already have - no detail-page fetch.
  const extraClassification = await classifyExtraEntries(extraEntries, {
    headless
  });

  const listCardAdsById = buildMissingFromListCards(missingEntries);
  const missingClassification = (() => {
    const enrichedAds = Array.from(listCardAdsById.values());
    const accepted = new Set(
      filterRelevantAds(enrichedAds, { requireExplicitRooms: true }).map(
        (a) => a.externalId
      )
    );
    const result = new Map();
    for (const entry of missingEntries) {
      const enriched = listCardAdsById.get(entry.externalId);
      if (!enriched) {
        result.set(entry.externalId, {
          kind: 'unenriched',
          reason: 'לא נמצאה ברשומות הסריקה החיה'
        });
        continue;
      }
      if (accepted.has(entry.externalId)) {
        result.set(entry.externalId, { kind: 'admit', enriched });
      } else {
        result.set(entry.externalId, {
          kind: 'rejected',
          reason: 'נדחתה על ידי סינון הרלוונטיות',
          enriched
        });
      }
    }
    return result;
  })();

  const reconciliation = reconcileSeen({
    rows,
    seen: seenInitial,
    extraClassification,
    missingClassification,
    generatedAt,
    searchById,
    filterLimitsBySearchId
  });

  // Save the reconciled seen-set locally. The actual push to the `state`
  // branch happens in main() AFTER we record the run entry, so runs.json
  // is included in the same commit. We swallow save errors so a
  // persistence bug never blocks the Telegram report.
  const didMutate =
    reconciliation.additions.length > 0 || reconciliation.removals.length > 0;
  let persisted = {
    ok: false,
    reason: didMutate ? 'pending (will push from main)' : 'no diffs to reconcile'
  };
  if (didMutate) {
    try {
      saveSeenAds(reconciliation.updatedSeen);
    } catch (error) {
      console.error('[health-check] failed to save reconciled seen-set:', error);
      persisted = {
        ok: false,
        reason: `save threw: ${error.message || 'unknown'}`
      };
    }
  }

  // Recompute table rows against the post-reconciliation seen-set so the
  // Telegram message reflects the now-current state, not the pre-fix one.
  const reconciledExpectedBySearchId = buildExpectedBySearchId(
    reconciliation.updatedSeen
  );

  const finalRows = rows.map((row) => {
    const seenIdSet = new Set(
      reconciledExpectedBySearchId[row.searchId]?.ids || []
    );
    const expected = reconciledExpectedBySearchId[row.searchId]?.count || 0;
    const scrapedIdSet = new Set(row.scrapedIds || []);

    return {
      ...row,
      expected,
      seenIds: [...seenIdSet],
      missingIds: [...scrapedIdSet].filter((id) => !seenIdSet.has(id)),
      extraIds: [...seenIdSet].filter((id) => !scrapedIdSet.has(id))
    };
  });

  const annotatedRows = annotateRowsWithReconciliation(finalRows, reconciliation);

  const allMatch =
    annotatedRows.every((row) => !row.error) &&
    annotatedRows.every((row) => row.real === row.expected);

  return {
    rows: annotatedRows,
    allMatch,
    generatedAt,
    scrapeErrors: scrapeResult.errors || [],
    reconciliation: {
      additions: reconciliation.additions,
      removals: reconciliation.removals,
      unresolvedExtras: reconciliation.unresolvedExtras,
      unresolvedMissing: reconciliation.unresolvedMissing,
      didMutate,
      persisted
    }
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const trigger = (process.env.HEALTH_CHECK_TRIGGER_LABEL || 'github-actions').trim() || 'github-actions';
  try {
    const result = await runHealthCheck();
    const telegram = await sendHealthCheckReport({
      rows: result.rows,
      allMatch: result.allMatch,
      generatedAt: result.generatedAt,
      reconciliation: result.reconciliation
    });

    recordRun({
      kind: 'health-check',
      startedAt,
      completedAt: new Date().toISOString(),
      status: result.allMatch ? 'completed' : 'partial',
      trigger,
      allMatch: result.allMatch,
      additions: result.reconciliation?.additions?.length || 0,
      removals: result.reconciliation?.removals?.length || 0,
      unresolvedExtras: result.reconciliation?.unresolvedExtras?.length || 0,
      unresolvedMissing: result.reconciliation?.unresolvedMissing?.length || 0,
      telegramSent: Boolean(telegram && !telegram.skipped),
      errors: result.scrapeErrors || []
    });

    // Push state branch AFTER recordRun so runs.json includes this
    // run. We pass the freshly-removed externalIds to the merge step
    // so a concurrent scan's stale snapshot can't resurrect them.
    const removedIds = (result.reconciliation?.removals || [])
      .map((r) => r.externalId)
      .filter(Boolean);
    let persisted = result.reconciliation?.persisted;
    try {
      const pushResult = persistStateToBranch({ forceDeleteIds: removedIds });
      persisted = pushResult;
    } catch (pushErr) {
      console.error('[health-check] persistStateToBranch threw:', pushErr);
      persisted = { ok: false, reason: pushErr.message };
    }

    console.log(
      JSON.stringify(
        {
          allMatch: result.allMatch,
          generatedAt: result.generatedAt,
          rows: result.rows,
          scrapeErrors: result.scrapeErrors,
          reconciliation: { ...result.reconciliation, persisted },
          telegram
        },
        null,
        2
      )
    );
  } catch (error) {
    try {
      recordRun({
        kind: 'health-check',
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'failed',
        trigger,
        allMatch: false,
        additions: 0,
        removals: 0,
        unresolvedExtras: 0,
        unresolvedMissing: 0,
        telegramSent: false,
        errors: [{ message: error.message }]
      });
      // Still try to persist runs.json so the dashboard shows the failure.
      persistStateToBranch();
    } catch (recordErr) {
      console.error('[health-check] failed to record run entry:', recordErr);
    }
    console.error(error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildExpectedBySearchId,
  evaluateExtraAgainstFilters,
  reconcileSeen,
  runHealthCheck
};
