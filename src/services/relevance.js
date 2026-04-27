const MAX_PRICE = 9000;
const MIN_ROOMS = 4;

const EXCLUDED_KEYWORDS = [
  'שותפים',
  'שותף',
  'מרתף',
  'מקבלן',
  'יד ראשונה',
  'פרויקט חדש',
  'פרויקטים חדשים',
  'בלעדי בפרויקט',
  'תמ"א',
  'התחדשות עירונית',
  'מקודמת',
  'מקודמות',
  'מודעה מקודמת'
];

const RURAL_PREFIXES = ['קיבוץ', 'מושב', 'יישוב', 'ישוב', 'מושבה'];

const URBAN_BLOCKLIST = [
  'תל אביב',
  'תל-אביב',
  'ת"א',
  'חיפה',
  'באר שבע',
  'באר-שבע',
  'ירושלים',
  'ראשון לציון',
  'פתח תקווה',
  'פתח-תקווה',
  'נתניה',
  'אשדוד',
  'אשקלון',
  'הרצליה',
  'רעננה',
  'כפר סבא',
  'הוד השרון',
  'רמת גן',
  'רמת-גן',
  'בני ברק',
  'גבעתיים',
  'חולון',
  'בת ים',
  'בת-ים',
  'רחובות',
  'נס ציונה',
  'מודיעין',
  'מודיעין מכבים רעות',
  'לוד',
  'רמלה',
  'נצרת',
  'נצרת עילית',
  'נוף הגליל',
  'עפולה',
  'טבריה',
  'קרית שמונה',
  'קריית שמונה',
  'צפת',
  'מעלות',
  'מעלות תרשיחא',
  'עכו',
  'נהריה',
  'קרית אתא',
  'קריית אתא',
  'קרית מוצקין',
  'קריית מוצקין',
  'קרית ביאליק',
  'קריית ביאליק',
  'קרית ים',
  'קריית ים',
  'אילת',
  'דימונה',
  'ערד',
  'נתיבות',
  'אופקים',
  'שדרות',
  'קרית גת',
  'קריית גת',
  'קרית מלאכי',
  'קריית מלאכי',
  'יבנה',
  'גן יבנה',
  'חדרה',
  'אור יהודה',
  'יהוד',
  'קרית אונו',
  'קריית אונו',
  'גני תקווה',
  'מודיעין-מכבים-רעות',
  'בית שמש',
  'מעלה אדומים',
  'אריאל',
  'בית שאן',
  'מגדל העמק',
  'יוקנעם',
  'יקנעם',
  'כרמיאל',
  'טירת הכרמל',
  'אום אל פחם',
  'טייבה',
  'טירה',
  'קלנסואה',
  'רהט',
  'תמרה',
  'סחנין',
  'שפרעם',
  'מגדים',
  'נשר',
  'קרית חיים'
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

function getExcludedKeyword(haystack) {
  return EXCLUDED_KEYWORDS.find((keyword) => haystack.includes(normalize(keyword))) || null;
}

function looksRural(haystack) {
  return RURAL_PREFIXES.some((prefix) => haystack.includes(normalize(prefix)));
}

function looksUrban(haystack) {
  return URBAN_BLOCKLIST.some((city) => haystack.includes(normalize(city)));
}

function getRejection(ad, options = {}) {
  if (!isItemUrl(ad.link)) {
    return 'non-item-url';
  }

  if (!hasDistrictSegment(ad.link)) {
    return 'cross-district-suggestion';
  }

  const haystack = normalize(
    [ad.title, ad.rawText, ad.locationText, ad.searchLabel, ad.city, ad.propertyType]
      .filter(Boolean)
      .join(' ')
  );

  const blockedKeyword = getExcludedKeyword(haystack);
  if (blockedKeyword) {
    return `keyword:${blockedKeyword}`;
  }

  if (typeof ad.price === 'number' && ad.price > MAX_PRICE) {
    return `price:${ad.price}`;
  }

  if (options.requireExplicitRooms) {
    if (typeof ad.rooms !== 'number') {
      return 'no-rooms';
    }
  }

  if (typeof ad.rooms === 'number' && ad.rooms < MIN_ROOMS) {
    return `rooms:${ad.rooms}`;
  }

  if (looksUrban(haystack) && !looksRural(haystack)) {
    return 'urban-location';
  }

  if (!ad.settlementsOnly && !looksRural(haystack)) {
    return 'no-rural-marker';
  }

  return null;
}

function isRelevant(ad, options) {
  return getRejection(ad, options) === null;
}

function filterRelevantAds(ads, options) {
  return ads.filter((ad) => isRelevant(ad, options));
}

module.exports = {
  EXCLUDED_KEYWORDS,
  MAX_PRICE,
  MIN_ROOMS,
  RURAL_PREFIXES,
  URBAN_BLOCKLIST,
  getRejection,
  isRelevant,
  filterRelevantAds
};
