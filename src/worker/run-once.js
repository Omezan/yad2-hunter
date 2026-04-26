const { env } = require('../config/env');
const { getEnabledSearches } = require('../config/searches');
const {
  completeRun,
  createRun,
  ensureDatabaseReady,
  failRun,
  listRecentRuns,
  markRunNotificationSent,
  saveAndDetectNewAds
} = require('../db/repository');
const { closePool } = require('../db');
const { scrapeAllSearches } = require('../scraper/yad2');
const { filterRelevantAds } = require('../services/relevance');
const { sendNewAdsDigest } = require('../services/telegram');

async function runOnce(options = {}) {
  const searches = getEnabledSearches(env.ENABLED_SEARCH_IDS);
  const run = await createRun(options.note || options.trigger || 'manual');

  try {
    const scrapeResult = await scrapeAllSearches({
      searches,
      headless: env.PLAYWRIGHT_HEADLESS,
      timeoutMs: env.SEARCH_TIMEOUT_MS
    });

    const relevantAds = filterRelevantAds(scrapeResult.ads);
    const newAds = await saveAndDetectNewAds(relevantAds);

    await completeRun(run.id, {
      status: scrapeResult.errors.length ? 'partial' : 'completed',
      totalAds: scrapeResult.ads.length,
      relevantAds: relevantAds.length,
      newAds: newAds.length,
      errors: scrapeResult.errors
    });

    let telegramResult = { skipped: true, reason: 'No new ads' };

    if (newAds.length > 0) {
      telegramResult = await sendNewAdsDigest({ newAds });

      if (!telegramResult.skipped) {
        await markRunNotificationSent(run.id);
      }
    }

    return {
      runId: run.id,
      searches: searches.map((search) => search.id),
      totalAds: scrapeResult.ads.length,
      relevantAds: relevantAds.length,
      newAds: newAds.length,
      errors: scrapeResult.errors,
      telegramResult
    };
  } catch (error) {
    await failRun(run.id, error);
    throw error;
  }
}

async function main() {
  try {
    await ensureDatabaseReady();
    const result = await runOnce({ trigger: 'cli' });
    const recentRuns = await listRecentRuns(5);

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
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runOnce
};
