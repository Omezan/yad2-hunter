const { env } = require('../config/env');
const {
  getEnabledSearches,
  getSelfPrunedSearchIds
} = require('../config/searches');
const {
  commitAds,
  ensureStateDir,
  listRecentRuns,
  loadSeenAds,
  recordRun,
  removeDeletedAds,
  saveSeenAds,
  splitNewAndExisting
} = require('../store/file-store');
const { scrapeAllSearches } = require('../scraper/yad2');
const { filterRelevantAds, getRejection } = require('../services/relevance');
const {
  sendManualScanNoNewAdsNotice,
  sendNewAdsDigest
} = require('../services/telegram');
const {
  sendManualScanNoNewAdsEmail,
  sendNewAdsDigestEmail
} = require('../services/email');

const MANUAL_TRIGGERS = new Set(['manual-dashboard', 'manual']);

function parseIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Build a map searchId -> notifyVia by walking the active search list.
// Defaults to 'telegram' for anything without an explicit channel,
// preserving the historical behavior of the original 5 districts.
function buildNotifyChannelMap(searches = []) {
  const map = new Map();
  for (const search of searches) {
    if (!search || !search.id) continue;
    map.set(search.id, search.notifyVia === 'email' ? 'email' : 'telegram');
  }
  return map;
}

// Split a list of ads by which channel their searchId routes to.
// Ads with an unknown searchId fall back to Telegram (the historical
// default) so we never silently lose a notification.
function partitionAdsByChannel(ads, channelMap) {
  const telegramAds = [];
  const emailAds = [];
  for (const ad of Array.isArray(ads) ? ads : []) {
    if (!ad) continue;
    const channel = channelMap.get(ad.searchId) || 'telegram';
    if (channel === 'email') emailAds.push(ad);
    else telegramAds.push(ad);
  }
  return { telegramAds, emailAds };
}

// Decide which searchIds should be passed to the silent-prune step
// (i.e. scan-side removeDeletedAds) given the list of searches that
// just ran and the set of searchIds whose scrape errored out. Only
// the intersection of:
//   - the global "self-pruned" set (currently lev-hapark-*),
//   - searches actually included in this run, and
//   - searches that did NOT error
// is eligible. This is what enforces the "moshav data layer is never
// touched by silent prune" invariant — moshav ids are not in the
// self-pruned set, so they can never appear here.
function pickSilentPruneSearchIds({ searches, erroredSearchIds, selfPrunedIds }) {
  const erroredSet =
    erroredSearchIds instanceof Set
      ? erroredSearchIds
      : new Set(erroredSearchIds || []);
  const allowed =
    selfPrunedIds instanceof Set
      ? selfPrunedIds
      : new Set(selfPrunedIds || []);
  const result = [];
  for (const search of searches || []) {
    if (!search || !search.id) continue;
    if (!allowed.has(search.id)) continue;
    if (erroredSet.has(search.id)) continue;
    result.push(search.id);
  }
  return result;
}

// Decide which channels deserve a "no new ads" manual-scan notice.
// We only send it on the channel the user effectively asked about:
//   - If they explicitly selected a district set on the dashboard,
//     the notice fires for the channel(s) those searches notify on.
//   - If they ran the global cron-style scan (no explicit selection),
//     we keep the historical Telegram-only notice.
function pickManualNoticeChannels({ explicitlyRequestedIds, channelMap }) {
  if (!explicitlyRequestedIds || !explicitlyRequestedIds.length) {
    return { telegram: true, email: false };
  }
  const channels = { telegram: false, email: false };
  for (const id of explicitlyRequestedIds) {
    const ch = channelMap.get(id) || 'telegram';
    channels[ch] = true;
  }
  return channels;
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

    // Scan is additive for moshav districts: we notify on relevantNewAds,
    // write them into seen-ads (so the next run won't re-announce them),
    // and never delete moshav records here — moshav deletions are owned
    // by the health-check, which probes each "missing" listing for a 404
    // before removing.
    commitAds({
      newAds: relevantNewAds,
      existingAds
    });

    // The Lev HaPark watch opts out of the health-check entirely (see
    // src/config/searches.js#excludeFromHealthCheck), so the scan itself
    // is responsible for retiring its stale records. We reuse
    // removeDeletedAds — which has built-in trust guards (min live
    // count + min live/seen ratio) so a captcha or anti-bot zero-result
    // can never wipe the index — and pass it ONLY the self-pruned
    // search ids that scraped successfully in this run. Moshav records
    // are invisible to this step.
    const selfPrunedAll = getSelfPrunedSearchIds();
    const erroredSearchIds = new Set(
      (scrapeResult.errors || []).map((err) => err && err.searchId).filter(Boolean)
    );
    const scrapedSelfPrunedIds = pickSilentPruneSearchIds({
      searches,
      erroredSearchIds,
      selfPrunedIds: selfPrunedAll
    });

    let silentlyRemovedAds = [];
    let silentPruneSkippedDistricts = [];
    if (scrapedSelfPrunedIds.length > 0) {
      const seenAfterCommit = loadSeenAds();
      const scrapedAdsForSelfPrune = scrapeResult.ads.filter((ad) =>
        ad && selfPrunedAll.has(ad.searchId)
      );
      const pruneResult = removeDeletedAds(
        seenAfterCommit,
        scrapedAdsForSelfPrune,
        scrapedSelfPrunedIds
      );
      if (pruneResult.removed.length > 0) {
        saveSeenAds(pruneResult.seen);
      }
      silentlyRemovedAds = pruneResult.removed;
      silentPruneSkippedDistricts = pruneResult.skippedDistricts;
    }

    // Route ads to their notification channel. The original 5 moshav
    // districts default to Telegram (no change to legacy behavior).
    // The Lev HaPark watch (lev-hapark-*) carries `notifyVia: 'email'`
    // in its search config and is routed to the email digest instead.
    const channelMap = buildNotifyChannelMap(searches);
    const { telegramAds: byTelegramChannel, emailAds: byEmailChannel } =
      partitionAdsByChannel(relevantNewAds, channelMap);

    // Telegram-only filter: keeps the data layer (seen / dashboard /
    // health-check) untouched while honouring the user's preference
    // not to be paged about specific districts. Applied only on the
    // Telegram branch — email recipients see everything from their
    // own searches.
    const telegramAds = selectAdsForTelegram({
      ads: byTelegramChannel,
      suppressDistrictIds,
      explicitlyRequestedIds
    });
    const suppressedAdsCount = byTelegramChannel.length - telegramAds.length;
    const emailAds = byEmailChannel;

    const manualNoticeChannels = pickManualNoticeChannels({
      explicitlyRequestedIds,
      channelMap
    });

    let telegramResult = { skipped: true, reason: 'No new ads' };
    if (telegramAds.length > 0) {
      telegramResult = await sendNewAdsDigest({
        newAds: telegramAds,
        runStartedAt: startedAt
      });
    } else if (MANUAL_TRIGGERS.has(trigger) && manualNoticeChannels.telegram) {
      telegramResult = await sendManualScanNoNewAdsNotice({
        runStartedAt: startedAt
      });
    } else if (suppressedAdsCount > 0) {
      telegramResult = {
        skipped: true,
        reason: `All ${suppressedAdsCount} new ads belong to suppressed districts`
      };
    }

    let emailResult = { skipped: true, reason: 'No new ads' };
    if (emailAds.length > 0) {
      emailResult = await sendNewAdsDigestEmail({
        newAds: emailAds,
        runStartedAt: startedAt
      });
    } else if (MANUAL_TRIGGERS.has(trigger) && manualNoticeChannels.email) {
      emailResult = await sendManualScanNoNewAdsEmail({
        runStartedAt: startedAt
      });
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
      notifiedEmailAds: emailAds.length,
      suppressedNewAds: suppressedAdsCount,
      silentlyRemovedAds: silentlyRemovedAds.length,
      telegramSent: Boolean(telegramResult && !telegramResult.skipped),
      emailSent: Boolean(emailResult && !emailResult.skipped),
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
      silentPrune: {
        scrapedSearchIds: scrapedSelfPrunedIds,
        removed: silentlyRemovedAds,
        skippedDistricts: silentPruneSkippedDistricts
      },
      telegramResult,
      emailResult
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
      emailSent: false,
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

    // Surface silent-prune deletions to the workflow's subsequent
    // persist-state step. The state-merge helper reads
    // SEEN_ADS_FORCE_DELETE_IDS to subtract these keys after merging
    // with origin/state, preventing a concurrent run's stale snapshot
    // from resurrecting them. When not running under GitHub Actions,
    // or when there's nothing to delete, this is a no-op.
    if (process.env.GITHUB_ENV) {
      const removedIds = (result.silentPrune?.removed || [])
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
            `[run-once] could not write SEEN_ADS_FORCE_DELETE_IDS to GITHUB_ENV: ${err.message}`
          );
        }
      }
    }

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
  selectAdsForTelegram,
  buildNotifyChannelMap,
  partitionAdsByChannel,
  pickManualNoticeChannels,
  pickSilentPruneSearchIds
};
