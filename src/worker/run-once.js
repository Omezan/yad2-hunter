const { env } = require('../config/env');
const { getEnabledSearches } = require('../config/searches');
const {
  commitAds,
  ensureStateDir,
  listRecentRuns,
  recordRun,
  splitNewAndExisting
} = require('../store/file-store');
const {
  buildActiveCooldownMap,
  clearCooldown,
  describeCooldown,
  loadCooldowns,
  pruneExpired,
  saveCooldowns,
  setBlocked
} = require('../store/scrape-cooldowns');
const { scrapeAllSearches } = require('../scraper/yad2');
const { filterRelevantAds, getRejection } = require('../services/relevance');
const {
  sendManualScanNoNewAdsNotice,
  sendNewAdsDigest,
  sendPartialScrapeWarning
} = require('../services/telegram');
const {
  sendManualScanNoNewAdsEmail,
  sendNewAdsDigestEmail
} = require('../services/email');

// Any scrape error whose message matches this pattern is treated as
// a "we got blocked" signal that should trigger a cooldown for the
// search. Keep the pattern liberal so future wording tweaks in the
// scraper don't silently disable the backoff.
const BLOCKED_ERROR_PATTERN = /blocked|captcha|anti-?bot/i;

function isBlockedError(error) {
  if (!error || typeof error.message !== 'string') return false;
  return BLOCKED_ERROR_PATTERN.test(error.message);
}

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
  const startedAtMs = Date.parse(startedAt) || Date.now();
  const trigger = options.trigger || 'manual';

  // The dashboard's manual scan can request a specific district subset
  // via the ENABLED_SEARCH_IDS workflow input. We treat that subset as
  // an explicit user choice so the suppression list (e.g. north) is
  // overridden for districts the user asked about.
  const explicitlyRequestedIds = parseIdList(env.ENABLED_SEARCH_IDS);
  const suppressDistrictIds = parseIdList(env.TELEGRAM_SUPPRESS_DISTRICT_IDS);

  // Cooldown gate: load the cross-run cooldown state and split the
  // enabled searches into "we'll scrape these now" vs "still cooling
  // down from an earlier block". Skipped searches are reported via
  // the partial-scrape warning so the user knows why they didn't
  // run, but they're NOT failures — the dashboard data is unchanged.
  const cooldownEnabled = env.SCRAPE_COOLDOWN_MS > 0;
  const cooldownState = cooldownEnabled ? loadCooldowns() : { entries: {} };
  const activeCooldowns = cooldownEnabled
    ? buildActiveCooldownMap(cooldownState, startedAtMs)
    : new Map();

  const cooldownSkips = [];
  const searchesToScrape = [];
  for (const search of searches) {
    if (cooldownEnabled && activeCooldowns.has(search.id)) {
      const desc = describeCooldown(activeCooldowns.get(search.id));
      cooldownSkips.push({
        searchId: search.id,
        searchLabel: search.label,
        blockedAt: desc.blockedAt,
        blockedUntil: desc.blockedUntil
      });
    } else {
      searchesToScrape.push(search);
    }
  }

  try {
    const scrapeResult = searchesToScrape.length
      ? await scrapeAllSearches({
          searches: searchesToScrape,
          headless: env.PLAYWRIGHT_HEADLESS,
          timeoutMs: env.SEARCH_TIMEOUT_MS
        })
      : { ads: [], errors: [] };

    // Update the cooldown state based on what just happened. Two
    // things to do, in order:
    //   1. For every search we DID attempt, clear any stale cooldown
    //      that might exist (cheap defensive write — useful when a
    //      concurrent worker set one after we loaded the file).
    //   2. For every blocked-style error, install a fresh cooldown so
    //      the next iteration skips this search until the timeout
    //      passes.
    if (cooldownEnabled) {
      const blockedIds = new Set();
      for (const err of scrapeResult.errors || []) {
        if (isBlockedError(err) && err.searchId) {
          blockedIds.add(err.searchId);
        }
      }
      const completedAtMs = Date.now();
      for (const search of searchesToScrape) {
        if (!blockedIds.has(search.id)) {
          clearCooldown(cooldownState, search.id, completedAtMs);
        }
      }
      for (const id of blockedIds) {
        setBlocked(cooldownState, id, env.SCRAPE_COOLDOWN_MS, completedAtMs);
      }
      pruneExpired(cooldownState, completedAtMs);
      saveCooldowns(cooldownState);
    }

    const preFiltered = filterRelevantAds(scrapeResult.ads);
    const { newAds: newCandidates, existingAds } = splitNewAndExisting(preFiltered);

    const finalOptions = { requireExplicitRooms: true };
    const relevantNewAds = filterRelevantAds(newCandidates, finalOptions);

    const rejectionCounts = {
      preFilter: summarizeRejections(scrapeResult.ads),
      finalFilter: summarizeRejections(newCandidates, finalOptions)
    };

    const droppedNewCandidates = dumpRejectedNewCandidates(newCandidates, finalOptions);

    // Scan is purely additive: we notify on relevantNewAds, write them
    // into seen-ads (so the next run won't re-announce them), and
    // never delete anything here. Deletions across every watch are
    // owned by the daily health-check, which probes each "missing"
    // listing for a 404 before removing it.
    commitAds({
      newAds: relevantNewAds,
      existingAds
    });

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

    // When a manual trigger lands while every requested search is in
    // cooldown, we did NOT actually look at Yad2 — sending a "no new
    // ads" notice would be misleading because we don't know what's
    // new. The cooldown warning below carries the right signal, so we
    // suppress the per-channel manual notice in that case.
    const allRequestedInCooldown =
      cooldownSkips.length > 0 && searchesToScrape.length === 0;

    let telegramResult = { skipped: true, reason: 'No new ads' };
    if (telegramAds.length > 0) {
      telegramResult = await sendNewAdsDigest({
        newAds: telegramAds,
        runStartedAt: startedAt
      });
    } else if (
      MANUAL_TRIGGERS.has(trigger) &&
      manualNoticeChannels.telegram &&
      !allRequestedInCooldown
    ) {
      telegramResult = await sendManualScanNoNewAdsNotice({
        runStartedAt: startedAt
      });
    } else if (suppressedAdsCount > 0) {
      telegramResult = {
        skipped: true,
        reason: `All ${suppressedAdsCount} new ads belong to suppressed districts`
      };
    } else if (allRequestedInCooldown) {
      telegramResult = {
        skipped: true,
        reason: 'All requested searches in cooldown; warning notice covers it'
      };
    }

    let emailResult = { skipped: true, reason: 'No new ads' };
    if (emailAds.length > 0) {
      emailResult = await sendNewAdsDigestEmail({
        newAds: emailAds,
        runStartedAt: startedAt
      });
    } else if (
      MANUAL_TRIGGERS.has(trigger) &&
      manualNoticeChannels.email &&
      !allRequestedInCooldown
    ) {
      emailResult = await sendManualScanNoNewAdsEmail({
        runStartedAt: startedAt
      });
    }

    // Operational notice: if any watch was blocked, errored, or is
    // currently in cooldown after an earlier block, send a SEPARATE
    // Telegram message listing the affected watches. Always fires
    // when there's anything to report, on every iteration (no dedupe)
    // — this is the contract the user chose; signal beats silence
    // when the scraper is being rate-limited.
    let scrapeWarningResult = { skipped: true, reason: 'No scrape errors' };
    const hasScrapeErrors =
      Array.isArray(scrapeResult.errors) && scrapeResult.errors.length > 0;
    const hasCooldownSkips = cooldownSkips.length > 0;
    if (hasScrapeErrors || hasCooldownSkips) {
      try {
        scrapeWarningResult = await sendPartialScrapeWarning({
          errors: scrapeResult.errors,
          cooldownSkips,
          runStartedAt: startedAt
        });
      } catch (warnErr) {
        scrapeWarningResult = {
          skipped: true,
          reason: `Failed to send partial-scrape warning: ${
            warnErr && warnErr.message ? warnErr.message : warnErr
          }`
        };
      }
    }

    const runEntry = {
      kind: 'scan',
      startedAt,
      completedAt: new Date().toISOString(),
      status:
        scrapeResult.errors.length || cooldownSkips.length ? 'partial' : 'completed',
      trigger,
      totalAds: scrapeResult.ads.length,
      preFilteredAds: preFiltered.length,
      candidateNewAds: newCandidates.length,
      relevantNewAds: relevantNewAds.length,
      notifiedNewAds: telegramAds.length,
      notifiedEmailAds: emailAds.length,
      suppressedNewAds: suppressedAdsCount,
      telegramSent: Boolean(telegramResult && !telegramResult.skipped),
      emailSent: Boolean(emailResult && !emailResult.skipped),
      errors: scrapeResult.errors,
      cooldownSkips
    };

    recordRun(runEntry);

    return {
      ...runEntry,
      searches: searches.map((search) => search.id),
      attemptedSearches: searchesToScrape.map((search) => search.id),
      explicitlyRequestedIds,
      suppressDistrictIds,
      rejectionCounts,
      droppedNewCandidates,
      telegramResult,
      emailResult,
      scrapeWarningResult
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
  pickManualNoticeChannels
};
