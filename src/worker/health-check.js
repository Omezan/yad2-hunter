const { spawnSync } = require('child_process');
const path = require('path');
const { env } = require('../config/env');
const { getEnabledSearches } = require('../config/searches');
const { ensureStateDir, loadSeenAds } = require('../store/file-store');
const { scrapeAllSearches } = require('../scraper/yad2');
const { sendHealthCheckReport } = require('../services/telegram');

function refreshStateFromBranch() {
  // Pull whatever the looping scan has just pushed to the `state` branch.
  // We do this AFTER the live scrape so any ad the scan added during the
  // scrape window is visible to us before we compute diffs (which would
  // otherwise show false "missing in seen" rows).
  const stateDir = env.STATE_DIR;
  if (!stateDir) return;
  if (!process.env.GITHUB_ACTIONS) return;

  const repoRoot = path.resolve(__dirname, '..', '..');
  const fetchResult = spawnSync(
    'git',
    ['fetch', '--depth=1', 'origin', 'state'],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (fetchResult.status !== 0) {
    console.warn('[health-check] could not fetch origin/state; using stale seen-set');
    return;
  }
  const checkoutResult = spawnSync(
    'git',
    [`--work-tree=${stateDir}`, 'checkout', 'origin/state', '--', '.'],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (checkoutResult.status !== 0) {
    console.warn('[health-check] could not checkout origin/state into state dir');
  }
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

async function runHealthCheck() {
  ensureStateDir();

  const searches = getEnabledSearches(env.ENABLED_SEARCH_IDS);
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

  const seen = loadSeenAds();
  const expectedBySearchId = buildExpectedBySearchId(seen);
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

  const allMatch =
    rows.every((row) => !row.error) && rows.every((row) => row.real === row.expected);

  const generatedAt = new Date().toISOString();

  return { rows, allMatch, generatedAt, scrapeErrors: scrapeResult.errors || [] };
}

async function main() {
  try {
    const result = await runHealthCheck();
    const telegram = await sendHealthCheckReport({
      rows: result.rows,
      allMatch: result.allMatch,
      generatedAt: result.generatedAt
    });

    console.log(
      JSON.stringify(
        {
          allMatch: result.allMatch,
          generatedAt: result.generatedAt,
          rows: result.rows,
          scrapeErrors: result.scrapeErrors,
          telegram
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runHealthCheck
};
