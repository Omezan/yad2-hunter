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

function parseIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Decide which ads should still trigger a Telegram digest. By default,
// any district listed in TELEGRAM_SUPPRESS_DISTRICT_IDS is silenced —
// the ads are still added to seen-ads.json, shown on the dashboard,
// and counted by the health-check. Only the push notification is
// dropped. When a manual run was triggered with an explicit district
// selection (via ENABLED_SEARCH_IDS) we treat the user's selection as
// an override: districts they explicitly asked for are notified even
// if they are normally suppressed.
function selectAdsForTelegram({
  ads,
  suppressDistrictIds,
  explicitlyRequestedIds
}) {
  if (!Array.isArray(ads) || !ads.length) return [];
  const suppressed = new Set(suppressDistrictIds || []);
  const requested = new Set(explicitlyRequestedIds || []);
  if (!suppressed.size) return ads.slice();
  return ads.filter((ad) => {
    if (!ad || !ad.searchId) return true;
    if (!suppressed.has(ad.searchId)) return true;
    return requested.has(ad.searchId);
  });
}

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

  // The dashboard's manual scan can request a specific district subset
  // via the ENABLED_SEARCH_IDS workflow input. We treat that subset as
  // an explicit user choice so the suppression list (e.g. north) is
  // overridden for districts the user asked about.
  const explicitlyRequestedIds = parseIdList(env.ENABLED_SEARCH_IDS);
  const suppressDistrictIds = parseIdList(env.TELEGRAM_SUPPRESS_DISTRICT_IDS);

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

    // Scan is additive only: we notify on relevantNewAds, write them
    // into seen-ads (so the very next run won't re-announce them), and
    // never delete anything here. Deletions are owned by the
    // health-check, which actually probes each "missing" listing for a
    // 404 before removing.
    commitAds({
      newAds: relevantNewAds,
      existingAds
    });

    // Telegram-only filter: keeps the data layer (seen / dashboard /
    // health-check) untouched while honouring the user's preference
    // not to be paged about specific districts.
    const telegramAds = selectAdsForTelegram({
      ads: relevantNewAds,
      suppressDistrictIds,
      explicitlyRequestedIds
    });
    const suppressedAdsCount = relevantNewAds.length - telegramAds.length;

    let telegramResult = { skipped: true, reason: 'No new ads' };
    if (telegramAds.length > 0) {
      telegramResult = await sendNewAdsDigest({
        newAds: telegramAds,
        runStartedAt: startedAt
      });
    } else if (MANUAL_TRIGGERS.has(trigger)) {
      telegramResult = await sendManualScanNoNewAdsNotice({
        runStartedAt: startedAt
      });
    } else if (suppressedAdsCount > 0) {
      telegramResult = {
        skipped: true,
        reason: `All ${suppressedAdsCount} new ads belong to suppressed districts`
      };
    }

    const runEntry = {
      kind: 'scan',
      startedAt,
      completedAt: new Date().toISOString(),
      status: scrapeResult.errors.length ? 'partial' : 'completed',
      trigger,
      totalAds: scrapeResult.ads.length,
      preFilteredAds: preFiltered.length,
      candidateNewAds: newCandidates.length,
      relevantNewAds: relevantNewAds.length,
      notifiedNewAds: telegramAds.length,
      suppressedNewAds: suppressedAdsCount,
      telegramSent: Boolean(telegramResult && !telegramResult.skipped),
      errors: scrapeResult.errors
    };

    recordRun(runEntry);

    return {
      ...runEntry,
      searches: searches.map((search) => search.id),
      explicitlyRequestedIds,
      suppressDistrictIds,
      rejectionCounts,
      droppedNewCandidates,
      telegramResult
    };
  } catch (error) {
    recordRun({
      kind: 'scan',
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'failed',
      trigger,
      totalAds: 0,
      preFilteredAds: 0,
      candidateNewAds: 0,
      relevantNewAds: 0,
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
  selectAdsForTelegram
};
