const { env } = require('../config/env');
const { getEnabledSearches } = require('../config/searches');
const {
  commitAds,
  ensureStateDir,
  listRecentRuns,
  recordRun,
  splitNewAndExisting
} = require('../store/file-store');
const { scrapeAllSearches } = require('../scraper/yad2');
const { filterRelevantAds, getRejection } = require('../services/relevance');
const {
  sendManualScanNoNewAdsNotice,
  sendNewAdsDigest
} = require('../services/telegram');

const MANUAL_TRIGGERS = new Set(['manual-dashboard', 'manual']);

// We deliberately do NOT enrich detail pages anymore: Yad2's anti-bot
// rejects most direct detail-page GETs from GitHub-hosted Playwright
// sessions, which used to leak captcha / agency / placeholder text
// into the seen-set. The list-card scrape gives us everything we
// actually need (title, city, rooms, price, district, link) and is
// reliable because it warms up via the search page.

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

    const finalOptions = { requireExplicitRooms: true };
    const relevantNewAds = filterRelevantAds(newCandidates, finalOptions);

    const rejectionCounts = {
      preFilter: summarizeRejections(scrapeResult.ads),
      finalFilter: summarizeRejections(newCandidates, finalOptions)
    };

    const droppedNewCandidates = dumpRejectedNewCandidates(newCandidates, finalOptions);

    const erroredSearchIds = new Set(
      (scrapeResult.errors || []).map((e) => e && e.searchId).filter(Boolean)
    );
    const scrapedSearchIds = searches
      .map((s) => s.id)
      .filter((id) => !erroredSearchIds.has(id));

    const { removed: removedAds = [], skippedDistricts = [] } = commitAds({
      newAds: relevantNewAds,
      existingAds,
      allScrapedAds: scrapeResult.ads,
      scrapedSearchIds
    });
    if (skippedDistricts.length) {
      console.warn(
        `[run-once] skipped removal cleanup for ${skippedDistricts.length} suspicious district(s): ${JSON.stringify(skippedDistricts)}`
      );
    }

    let telegramResult = { skipped: true, reason: 'No new ads' };
    if (relevantNewAds.length > 0) {
      telegramResult = await sendNewAdsDigest({
        newAds: relevantNewAds,
        runStartedAt: startedAt
      });
    } else if (MANUAL_TRIGGERS.has(trigger)) {
      telegramResult = await sendManualScanNoNewAdsNotice({
        runStartedAt: startedAt
      });
    }

    const runEntry = {
      startedAt,
      completedAt: new Date().toISOString(),
      status: scrapeResult.errors.length ? 'partial' : 'completed',
      trigger,
      totalAds: scrapeResult.ads.length,
      preFilteredAds: preFiltered.length,
      candidateNewAds: newCandidates.length,
      relevantNewAds: relevantNewAds.length,
      removedAds: removedAds.length,
      skippedRemovalDistricts: skippedDistricts,
      telegramSent: Boolean(telegramResult && !telegramResult.skipped),
      errors: scrapeResult.errors
    };

    recordRun(runEntry);

    return {
      ...runEntry,
      searches: searches.map((search) => search.id),
      rejectionCounts,
      droppedNewCandidates,
      removedAdSamples: removedAds.slice(0, 20),
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
      relevantNewAds: 0,
      removedAds: 0,
      telegramSent: false,
      errors: [{ message: error.message }]
    });
    throw error;
  }
}

async function main() {
  try {
    const trigger = (process.env.SCAN_TRIGGER_LABEL || 'github-actions').trim();
    const result = await runOnce({ trigger: trigger || 'github-actions' });
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
