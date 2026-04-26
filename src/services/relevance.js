const EXCLUDED_KEYWORDS = ['שותפים', 'מרתף'];

function normalizeText(text) {
  return String(text || '').trim().toLowerCase();
}

function getRejectedKeyword(ad) {
  const haystack = normalizeText(
    [ad.title, ad.rawText, ad.locationText, ad.searchLabel].filter(Boolean).join(' ')
  );

  return EXCLUDED_KEYWORDS.find((keyword) => haystack.includes(keyword)) || null;
}

function isRelevant(ad) {
  return !getRejectedKeyword(ad);
}

function filterRelevantAds(ads) {
  return ads.filter(isRelevant);
}

module.exports = {
  EXCLUDED_KEYWORDS,
  getRejectedKeyword,
  isRelevant,
  filterRelevantAds
};
