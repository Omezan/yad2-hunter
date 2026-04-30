const { env } = require('../config/env');
const { getEnabledSearches } = require('../config/searches');
const {
  commitAds,
  ensureStateDir,
  listRecentRuns,
  loadSeenAds,
  recordRun,
  splitNewAndExisting
} = require('../store/file-store');
const {
  enrichAdsWithDetails,
  isYad2ErrorText,
  scrapeAllSearches
} = require('../scraper/yad2');
const { filterRelevantAds, getRejection } = require('../services/relevance');
const {
  sendManualScanNoNewAdsNotice,
  sendNewAdsDigest
} = require('../services/telegram');

const MANUAL_TRIGGERS = new Set(['manual-dashboard', 'manual']);

const ENRICH_TIMEOUT_MS = 12000;
const ENRICH_CONCURRENCY = 4;
const MAX_ENRICH = 400;
const ENRICH_BUDGET_MS = 6 * 60 * 1000;
// Per-run cap on how many already-seen ads with poison fields we re-enrich
// to heal them. Keeps the loop's wall-clock predictable; remaining
// poisoned records will heal on subsequent runs.
const MAX_HEAL_PER_RUN = 25;
const HEAL_BUDGET_MS = 90 * 1000;

function needsHealing(record) {
  if (!record) return false;
  // Original error-widget text (covered by the previous fix).
  if (typeof record.city === 'string' && isYad2ErrorText(record.city)) return true;
  if (typeof record.title === 'string' && isYad2ErrorText(record.title)) return true;
  // Records the migration neutralised but haven't been re-enriched yet:
  // no city + a placeholder title means we never captured a real city.
  // Also catch records whose `city` is missing entirely OR whose title
  // is the neutral placeholder we wrote during migration. The detail
  // page is the canonical source for those fields.
  const hasCity = typeof record.city === 'string' && record.city.trim().length > 0;
  if (!hasCity) return true;
  if (record.title === 'מודעה' || record.title === 'מודעה ללא כותרת') return true;
  return false;
}

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

    const erroredSearchIds = new Set(
      (scrapeResult.errors || []).map((e) => e && e.searchId).filter(Boolean)
    );
    const scrapedSearchIds = searches
      .map((s) => s.id)
      .filter((id) => !erroredSearchIds.has(id));

    // Heal records whose previously-stored city/title looks like Yad2's
    // error widget. We re-enrich a small batch each run; the resulting
    // ads still travel through the existingAds path so commitAds can
    // overwrite their poisoned fields with clean ones.
    const seenForHeal = loadSeenAds();
    const healCandidates = existingAds.filter((ad) =>
      needsHealing(seenForHeal.ads?.[ad.externalId])
    );
    const healToEnrich = healCandidates.slice(0, MAX_HEAL_PER_RUN);
    let healedAds = [];
    if (healToEnrich.length) {
      console.log(
        `[run-once] healing ${healToEnrich.length} record(s) (missing/placeholder fields); will be refreshed via enrichment`
      );
      try {
        healedAds = await enrichAdsWithDetails({
          ads: healToEnrich,
          headless: env.PLAYWRIGHT_HEADLESS,
          timeoutMs: ENRICH_TIMEOUT_MS,
          concurrency: ENRICH_CONCURRENCY,
          budgetMs: HEAL_BUDGET_MS
        });
      } catch (err) {
        console.warn('[run-once] heal enrichment failed:', err && err.message);
        healedAds = [];
      }
    }
    // Replace poisoned existingAds entries with their healed counterpart.
    const healedById = new Map(
      healedAds.filter((a) => a && a.externalId).map((a) => [a.externalId, a])
    );
    const existingAdsForCommit = existingAds.map((ad) => {
      const healed = healedById.get(ad.externalId);
      return healed ? { ...ad, ...healed } : ad;
    });

    const { removed: removedAds = [], skippedDistricts = [] } = commitAds({
      newAds: relevantNewAds,
      existingAds: existingAdsForCommit,
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
      enrichedAds: enriched.length,
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
      enrichedAds: 0,
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
  runOnce,
  needsHealing
};
