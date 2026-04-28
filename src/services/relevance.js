const PROMO_KEYWORDS = [
  'פרויקט חדש',
  'פרויקטים חדשים',
  'בלעדי בפרויקט',
  'תמ"א',
  'התחדשות עירונית'
];

function normalize(text) {
  return String(text || '').replace(/[\u200e\u200f]/g, '').toLowerCase().trim();
}

function isItemUrl(link) {
  return typeof link === 'string' && /\/realestate\/item\//i.test(link);
}

function hasDistrictSegment(link) {
  return typeof link === 'string' && /\/realestate\/item\/[a-z-]+\/[a-z0-9]+/i.test(link);
}

function getPromoKeyword(haystack) {
  return PROMO_KEYWORDS.find((keyword) => haystack.includes(normalize(keyword))) || null;
}

function buildKeywordHaystack(ad) {
  const fields = ad.enriched
    ? [ad.title, ad.descriptionText, ad.propertyType]
    : [ad.title, ad.rawText, ad.locationText, ad.propertyType];
  return normalize(fields.filter(Boolean).join(' '));
}

function getRejection(ad) {
  if (!isItemUrl(ad.link)) {
    return 'non-item-url';
  }

  if (!hasDistrictSegment(ad.link)) {
    return 'cross-district-suggestion';
  }

  const haystack = buildKeywordHaystack(ad);
  const promo = getPromoKeyword(haystack);
  if (promo) {
    return `keyword:${promo}`;
  }

  return null;
}

function isRelevant(ad) {
  return getRejection(ad) === null;
}

function filterRelevantAds(ads) {
  return ads.filter((ad) => isRelevant(ad));
}

module.exports = {
  PROMO_KEYWORDS,
  getRejection,
  isRelevant,
  filterRelevantAds
};
