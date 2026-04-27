const { env } = require('../config/env');
const { getEnabledSearches } = require('../config/searches');
const {
  ensureStateDir,
  listRecentRuns,
  recordRun,
  saveAndDetectNewAds
} = require('../store/file-store');
const { enrichAdsWithDetails, scrapeAllSearches } = require('../scraper/yad2');
const { filterRelevantAds, getRejection } = require('../services/relevance');
const { sendNewAdsDigest } = require('../services/telegram');

function summarizeRejections(ads, options) {
  const counts = {};
  for (const ad of ads) {
    const reason = getRejection(ad, options);
    if (!reason) continue;
    const key = reason.split(':')[0];
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function runOnce(options = {}) {
  ensureStateDir();

  const searches = getEnabledSearches(env.ENABLED_SEARCH_IDS);
  const startedAt = new Date().toISOString();
  const trigger = options.trigger || 'manual';

  try {
    const scrapeResult = await scrapeAllSearches({
      searches,
      headless: env.PLAYWRIGHT_HEADLESS,
      timeoutMs: env.SEARCH_TIMEOUT_MS
    });

    const preFiltered = filterRelevantAds(scrapeResult.ads);
    const enriched = await enrichAdsWithDetails({
      ads: preFiltered,
      headless: env.PLAYWRIGHT_HEADLESS,
      timeoutMs: env.SEARCH_TIMEOUT_MS
    });
    const finalOptions = { requireExplicitPrice: true, requireExplicitRooms: true };
    const relevantAds = filterRelevantAds(enriched, finalOptions);
    const rejectionCounts = {
      preFilter: summarizeRejections(scrapeResult.ads),
      finalFilter: summarizeRejections(enriched, finalOptions)
    };
    const newAds = saveAndDetectNewAds(relevantAds);

    let telegramResult = { skipped: true, reason: 'No new ads' };

    if (newAds.length > 0) {
      telegramResult = await sendNewAdsDigest({ newAds });
    }

    const runEntry = {
      startedAt,
      completedAt: new Date().toISOString(),
      status: scrapeResult.errors.length ? 'partial' : 'completed',
      trigger,
      totalAds: scrapeResult.ads.length,
      relevantAds: relevantAds.length,
      newAds: newAds.length,
      telegramSent: Boolean(telegramResult && !telegramResult.skipped),
      errors: scrapeResult.errors
    };

    recordRun(runEntry);

    return {
      ...runEntry,
      searches: searches.map((search) => search.id),
      rejectionCounts,
      telegramResult
    };
  } catch (error) {
    recordRun({
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'failed',
      trigger,
      totalAds: 0,
      relevantAds: 0,
      newAds: 0,
      telegramSent: false,
      errors: [{ message: error.message }]
    });
    throw error;
  }
}

async function main() {
  try {
    const result = await runOnce({ trigger: 'github-actions' });
    const recentRuns = listRecentRuns(5);

    console.log(
      JSON.stringify(
        {
          ...result,
          recentRuns
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
  runOnce
};
