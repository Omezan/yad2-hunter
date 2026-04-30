const { env } = require('../config/env');
const { getEnabledSearches } = require('../config/searches');
const { scrapeAllSearches } = require('../scraper/yad2');
const { filterRelevantAds, getRejection } = require('../services/relevance');

const SAMPLES_PER_REASON = 5;

function summarize(label, ads, options) {
  const counts = {};
  const samples = {};

  for (const ad of ads) {
    const reason = getRejection(ad, options);
    if (!reason) continue;
    const key = reason.split(':')[0];
    counts[key] = (counts[key] || 0) + 1;
    if (!samples[key]) samples[key] = [];
    if (samples[key].length < SAMPLES_PER_REASON) {
      samples[key].push({
        reason,
        title: ad.title,
        city: ad.city,
        propertyType: ad.propertyType,
        rooms: ad.rooms,
        price: ad.price,
        hasExplicitPrice: ad.hasExplicitPrice,
        link: ad.link,
        searchLabel: ad.searchLabel
      });
    }
  }

  console.log(`\n=== ${label} ===`);
  console.log('Counts:', JSON.stringify(counts, null, 2));
  console.log('Samples:', JSON.stringify(samples, null, 2));
}

async function main() {
  const searches = getEnabledSearches(env.ENABLED_SEARCH_IDS);

  const scrapeResult = await scrapeAllSearches({
    searches,
    headless: env.PLAYWRIGHT_HEADLESS,
    timeoutMs: env.SEARCH_TIMEOUT_MS
  });

  console.log(`Total ads from feed: ${scrapeResult.ads.length}`);
  summarize('PRE-FILTER (relaxed) on feed data', scrapeResult.ads);

  const preFiltered = filterRelevantAds(scrapeResult.ads);
  console.log(`Pre-filtered ads (passed relaxed): ${preFiltered.length}`);

  const finalOptions = { requireExplicitRooms: true };
  summarize('FINAL FILTER (strict, on list-card data)', preFiltered, finalOptions);

  const finalAccepted = filterRelevantAds(preFiltered, finalOptions);
  console.log(`\nFinal accepted: ${finalAccepted.length}`);

  const byDistrict = {};
  for (const ad of finalAccepted) {
    const key = ad.searchLabel || ad.districtLabel || 'unknown';
    if (!byDistrict[key]) byDistrict[key] = [];
    byDistrict[key].push({
      title: ad.title,
      city: ad.city,
      rooms: ad.rooms,
      price: ad.price,
      publishedAt: ad.publishedAt || null,
      link: ad.link
    });
  }
  for (const [district, ads] of Object.entries(byDistrict)) {
    console.log(`\n--- ${district} (${ads.length}) ---`);
    console.log(JSON.stringify(ads, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
