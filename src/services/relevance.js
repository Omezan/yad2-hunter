const MAX_PRICE = 9000;
const MIN_ROOMS = 4;

const EXCLUDED_KEYWORDS = [
  'מחפש שותף',
  'מחפשת שותף',
  'מחפשים שותפ',
  'דרוש שותף',
  'דרושה שותפה',
  'דרושים שותפים',
  'דירת שותפים',
  'שותף לדירה',
  'שותפה לדירה',
  'דירת מרתף',
  'יחידת מרתף',
  'יחידה במרתף',
  'דיור מרתף',
  'מרתף להשכרה',
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

const HOUSE_PROPERTY_TYPES = [
  'בית פרטי',
  "בית פרטי/ קוטג'",
  'בית פרטי/ קוטג׳',
  "קוטג'",
  'קוטג׳',
  "קוטג' טורי",
  'קוטג׳ טורי',
  'וילה',
  'דו משפחתי',
  'דו-משפחתי',
  'מיני בית',
  'מיני וילה',
  'משק',
  'משק חקלאי',
  "מגרש"
];

const FLAT_PROPERTY_TYPES = [
  'דירה',
  'דירת גן',
  'דירת גג',
  'פנטהאוז',
  'פנטהאוס',
  'מיני פנטהאוז',
  'מיני פנטהאוס',
  'דופלקס',
  'טריפלקס',
  'יחידת דיור',
  'סטודיו',
  'לופט'
];

function isHouseType(propertyType) {
  if (!propertyType) return false;
  const normalized = normalize(propertyType);
  return HOUSE_PROPERTY_TYPES.some(
    (type) => normalized === normalize(type) || normalized.includes(normalize(type))
  );
}

function isFlatType(propertyType) {
  if (!propertyType) return false;
  const normalized = normalize(propertyType);
  return FLAT_PROPERTY_TYPES.some(
    (type) => normalized === normalize(type) || normalized.includes(normalize(type))
  );
}

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
  'נתיבות',
  'אופקים',
  'קרית גת',
  'קריית גת',
  'קרית מלאכי',
  'קריית מלאכי',
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
  'קלנסואה',
  'רהט',
  'סחנין',
  'שפרעם',
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

function tokenizeForMatch(text) {
  const tokens = String(text || '')
    .replace(/[\u200e\u200f]/g, '')
    .toLowerCase()
    .split(/[^\u0590-\u05ffA-Za-z0-9'"]+/)
    .filter(Boolean);
  const phrases = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    phrases.add(tokens[i]);
    if (i + 1 < tokens.length) {
      phrases.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
    if (i + 2 < tokens.length) {
      phrases.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
  }
  return phrases;
}

function tokenizedMatches(text, terms) {
  const phrases = tokenizeForMatch(text);
  return terms.find((term) => phrases.has(normalize(term))) || null;
}

function looksRural(haystack) {
  return Boolean(tokenizedMatches(haystack, RURAL_PREFIXES));
}

function looksUrban(haystack) {
  return Boolean(tokenizedMatches(haystack, URBAN_BLOCKLIST));
}

function buildLocationHaystack(ad) {
  const fields = ad.enriched
    ? [ad.title, ad.city, ad.addressText, ad.propertyType]
    : [ad.title, ad.locationText, ad.city, ad.addressText, ad.propertyType];
  return normalize(fields.filter(Boolean).join(' '));
}

function buildKeywordHaystack(ad) {
  const fields = ad.enriched
    ? [ad.title, ad.descriptionText, ad.propertyType]
    : [ad.title, ad.rawText, ad.locationText, ad.propertyType];
  return normalize(fields.filter(Boolean).join(' '));
}

function getRejection(ad, options = {}) {
  if (!isItemUrl(ad.link)) {
    return 'non-item-url';
  }

  if (!hasDistrictSegment(ad.link)) {
    return 'cross-district-suggestion';
  }

  if (typeof ad.price === 'number' && ad.price > MAX_PRICE) {
    return `price:${ad.price}`;
  }

  if (typeof ad.rooms === 'number' && ad.rooms < MIN_ROOMS) {
    return `rooms:${ad.rooms}`;
  }

  if (ad.enriched || options.useEnrichedFields) {
    const keywordHaystack = buildKeywordHaystack(ad);
    const blockedKeyword = getExcludedKeyword(keywordHaystack);
    if (blockedKeyword) {
      return `keyword:${blockedKeyword}`;
    }

    if (options.requireExplicitRooms && typeof ad.rooms !== 'number') {
      return 'no-rooms';
    }

    const locationHaystack = buildLocationHaystack(ad);
    if (looksUrban(locationHaystack) && !looksRural(locationHaystack)) {
      return 'urban-location';
    }

    if (!ad.settlementsOnly && !looksRural(locationHaystack)) {
      return 'no-rural-marker';
    }

    if (
      isFlatType(ad.propertyType) &&
      !isHouseType(ad.propertyType) &&
      typeof ad.floor === 'number' &&
      ad.floor >= 1
    ) {
      return `non-ground-floor:${ad.floor}`;
    }
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
  HOUSE_PROPERTY_TYPES,
  FLAT_PROPERTY_TYPES,
  MAX_PRICE,
  MIN_ROOMS,
  RURAL_PREFIXES,
  URBAN_BLOCKLIST,
  getRejection,
  isFlatType,
  isHouseType,
  isRelevant,
  filterRelevantAds
};
