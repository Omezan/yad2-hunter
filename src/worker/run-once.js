const { env } = require('../config/env');
const { getEnabledSearches } = require('../config/searches');
const {
  commitAds,
  ensureStateDir,
  listRecentRuns,
  recordRun,
  splitNewAndExisting
} = require('../store/file-store');
const { enrichAdsWithDetails, scrapeAllSearches } = require('../scraper/yad2');
const { filterRelevantAds, getRejection } = require('../services/relevance');
const { sendNewAdsDigest } = require('../services/telegram');

const ENRICH_TIMEOUT_MS = 12000;
const ENRICH_CONCURRENCY = 4;
const MAX_ENRICH = 400;
const ENRICH_BUDGET_MS = 6 * 60 * 1000;

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

function dumpRejectedNewCandidates(ads, options) {
  const dropped = [];
  for (const ad of ads) {
    const reason = getRejection(ad, options);
    if (!reason) continue;
    dropped.push({
      reason,
      enriched: Boolean(ad.enriched),
      searchId: ad.searchId,
      city: ad.city || null,
      propertyType: ad.propertyType || null,
      title: ad.title || null,
      addressText: ad.addressText || null,
      locationText: ad.locationText || null,
      floor: ad.floor ?? null,
      descriptionText: ad.descriptionText
        ? ad.descriptionText.slice(0, 500)
        : null,
      rawTextSample: ad.rawText ? ad.rawText.slice(0, 500) : null,
      rooms: ad.rooms ?? null,
      price: ad.price ?? null,
      link: ad.link
    });
  }
  return dropped;
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
    const { newAds: newCandidates, existingAds } = splitNewAndExisting(preFiltered);

    const candidatesToEnrich = newCandidates.slice(0, MAX_ENRICH);
    const cappedAtMaxEnrich = newCandidates.length - candidatesToEnrich.length;

    const enriched = await enrichAdsWithDetails({
      ads: candidatesToEnrich,
      headless: env.PLAYWRIGHT_HEADLESS,
      timeoutMs: ENRICH_TIMEOUT_MS,
      concurrency: ENRICH_CONCURRENCY,
      budgetMs: ENRICH_BUDGET_MS
    });

    const droppedDueToBudget = candidatesToEnrich.length - enriched.length;

    const finalOptions = { requireExplicitRooms: true };
    const relevantNewAds = filterRelevantAds(enriched, finalOptions);

    const rejectionCounts = {
      preFilter: summarizeRejections(scrapeResult.ads),
      finalFilter: summarizeRejections(enriched, finalOptions),
      cappedAtMaxEnrich,
      droppedDueToBudget
    };

    const droppedNewCandidates = dumpRejectedNewCandidates(enriched, finalOptions);

    commitAds({ newAds: relevantNewAds, existingAds });

    let telegramResult = { skipped: true, reason: 'No new ads' };
    if (relevantNewAds.length > 0) {
      telegramResult = await sendNewAdsDigest({ newAds: relevantNewAds });
    }

    const runEntry = {
      startedAt,
      completedAt: new Date().toISOString(),
      status: scrapeResult.errors.length ? 'partial' : 'completed',
      trigger,
      totalAds: scrapeResult.ads.length,
      preFilteredAds: preFiltered.length,
      candidateNewAds: newCandidates.length,
      enrichedAds: enriched.length,
      relevantNewAds: relevantNewAds.length,
      telegramSent: Boolean(telegramResult && !telegramResult.skipped),
      errors: scrapeResult.errors
    };

    recordRun(runEntry);

    return {
      ...runEntry,
      searches: searches.map((search) => search.id),
      rejectionCounts,
      droppedNewCandidates,
      telegramResult
    };
  } catch (error) {
    recordRun({
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'failed',
      trigger,
      totalAds: 0,
      preFilteredAds: 0,
      candidateNewAds: 0,
      enrichedAds: 0,
      relevantNewAds: 0,
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
