const { env } = require('./src/config/env');
const { getEnabledSearches } = require('./src/config/searches');
const { scrapeAllSearches } = require('./src/scraper/yad2');
const { filterRelevantAds } = require('./src/services/relevance');

async function main() {
  const searches = getEnabledSearches(env.ENABLED_SEARCH_IDS);
  const result = await scrapeAllSearches({
    searches,
    headless: env.PLAYWRIGHT_HEADLESS,
    timeoutMs: env.SEARCH_TIMEOUT_MS
  });

  const relevantAds = filterRelevantAds(result.ads);

  console.log(
    JSON.stringify(
      {
        scrapedAds: result.ads.length,
        relevantAds: relevantAds.length,
        errors: result.errors,
        sample: relevantAds.slice(0, 5)
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});