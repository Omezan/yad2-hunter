const { env } = require('../config/env');
const { getEnabledSearches } = require('../config/searches');
const {
  attachAdsToRun,
  completeRun,
  createRun,
  ensureDatabaseReady,
  failRun,
  markRunNotificationSent,
  upsertRelevantAds
} = require('../db/repository');
const { closePool } = require('../db');
const { scrapeAllSearches } = require('../scraper/yad2');
const { filterRelevantAds } = require('../services/relevance');
const { sendNewAdsDigest } = require('../services/telegram');

function buildRunUrl(runId) {
  return new URL(`/runs/${runId}`, env.APP_BASE_URL).toString();
}

async function runScan(options = {}) {
  const note = options.note || options.trigger || 'manual';
  const searches = getEnabledSearches(env.ENABLED_SEARCH_IDS);

  await ensureDatabaseReady();

  const run = await createRun(note);

  try {
    const scrapeResult = await scrapeAllSearches({
      searches,
      headless: env.PLAYWRIGHT_HEADLESS,
      timeoutMs: env.SEARCH_TIMEOUT_MS
    });

    const relevantAds = filterRelevantAds(scrapeResult.ads);
    const newAds = await upsertRelevantAds(relevantAds);
    await attachAdsToRun(
      run.id,
      newAds.map((ad) => ad.id)
    );

    await completeRun(run.id, {
      status: scrapeResult.errors.length ? 'partial' : 'completed',
      totalAds: scrapeResult.ads.length,
      relevantAds: relevantAds.length,
      newAds: newAds.length,
      errors: scrapeResult.errors
    });

    let telegramResult = { skipped: true, reason: 'No new ads' };

    if (newAds.length > 0) {
      telegramResult = await sendNewAdsDigest({
        runId: run.id,
        newAds,
        runUrl: buildRunUrl(run.id)
      });

      if (!telegramResult.skipped) {
        await markRunNotificationSent(run.id);
      }
    }

    return {
      runId: run.id,
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
    const result = await runScan({ trigger: 'cli' });
    console.log(JSON.stringify(result, null, 2));
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
  runScan
};
