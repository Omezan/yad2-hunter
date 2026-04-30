#!/usr/bin/env node
/**
 * One-shot migration script for `seen-ads.json`. Responsibilities:
 *
 *  1. Scrub Yad2 error-widget text ("אופס... תקלה!") from city/title.
 *  2. Scrub Yad2 anti-bot challenge text ("Are you for real?", Radware
 *     / ShieldSquare wording) accidentally written into city/title by
 *     a previous heal pass that ran while Yad2 was returning a captcha.
 *  3. Scrub the price-area placeholder "לא צוין מחיר" out of titles -
 *     it should never be a headline; the dashboard already renders
 *     "מחיר לא מצוין" via the structured `price` field.
 *  4. Heal records whose `title` is actually a price string or a rooms
 *     count (legacy list-card scraping bug). When found, we parse the
 *     value out into the structured `price` / `rooms` fields and reset
 *     the title to a neutral placeholder so the dashboard does not
 *     show a price string as the headline.
 *
 * Usage: node scripts/scrub-poison-state.js path/to/seen-ads.json
 */
const fs = require('fs');

function isErrorWidget(value) {
  return typeof value === 'string' && /אופס\.{2,3}\s*תקלה/.test(value);
}

const PROPERTY_TYPE_WORDS = [
  'דירה',
  'בית',
  'קוטג',
  'וילה',
  'פנטהאוז',
  'דופלקס',
  'מיני פנטהאוז',
  'מרתף',
  'גג',
  'סטודיו',
  'יחידת דיור',
  'דירת גן',
  'משק'
];

const PROPERTY_TYPE_ONLY_TITLES = new Set([
  'דירה',
  "בית פרטי/ קוטג'",
  "בית פרטי / קוטג'",
  'דירת גן',
  'דירת גג',
  'גג/ פנטהאוז',
  'גג / פנטהאוז',
  'דו משפחתי',
  'פנטהאוז',
  'יחידת דיור',
  'מיני פנטהאוז',
  'דופלקס',
  'טריפלקס',
  'וילה',
  'משק',
  'סטודיו'
]);

function looksLikePropertyTitle(title) {
  if (typeof title !== 'string') return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  // "דירה, חיפה" / "בית פרטי, רחובות" - canonical built titles.
  if (trimmed.includes(',')) return true;
  // Bare first word is a known property type.
  if (PROPERTY_TYPE_WORDS.some((w) => trimmed === w || trimmed.startsWith(`${w} `))) return true;
  return false;
}

function isPropertyTypeOnlyTitle(title) {
  if (typeof title !== 'string') return false;
  return PROPERTY_TYPE_ONLY_TITLES.has(title.trim());
}

function looksLikeAgencyTitle(title) {
  if (typeof title !== 'string') return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  // Common agency / brand markers.
  if (/נדל[״"']?ן/.test(trimmed)) return true;
  if (/RE\/?MAX/i.test(trimmed)) return true;
  if (/UNISTATE|RE\s*\/\s*MAX|REALTY|REAL\s+ESTATE/i.test(trimmed)) return true;
  if (/תיווך|נכסים|שיווק נדל|יזמות|קפיטל/.test(trimmed)) return true;
  // ALL-CAPS Latin words (e.g. "UNISTATE", "S+ REAL ESTATE") that
  // didn't already pattern-match above.
  if (/^[A-Z][A-Z0-9 +\-/]{2,}$/.test(trimmed)) return true;
  return false;
}

function isAntiBotText(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/are\s+you\s+for\s+real/i.test(trimmed)) return true;
  if (/shieldsquare|radware|bot\s*manager\s*block|captcha\s*digest|incident\s*id/i.test(trimmed)) {
    return true;
  }
  if (/אבטחת\s*אתר|מסיבות\s*אבטחה/i.test(trimmed)) return true;
  return false;
}

function isPricePlaceholderText(value) {
  if (typeof value !== 'string') return false;
  return /^\s*לא\s+צוין\s+מחיר\s*$/.test(value.trim());
}

function isPoisonText(value) {
  return isErrorWidget(value) || isAntiBotText(value) || isPricePlaceholderText(value);
}

function parsePriceFromTitle(title) {
  if (typeof title !== 'string') return null;
  const match = title.match(/(?:[\d.,]+)\s*₪|₪\s*([\d.,]+)/);
  if (!match) return null;
  const numericText = (match[0].match(/[\d.,]+/) || [''])[0].replace(/[^\d]/g, '');
  if (!numericText) return null;
  const value = Number.parseInt(numericText, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseRoomsFromTitle(title) {
  if (typeof title !== 'string') return null;
  const match = title.match(/(\d+(?:\.\d+)?)\s*(?:חד׳|חדר(?:ים)?)/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function looksPriceLikeTitle(title) {
  if (typeof title !== 'string') return false;
  // "₪ 5,300", "5300 ₪", "ירד ב-500 ₪", or pure currency strings.
  return /₪/.test(title) || /\d{2,}\s*ש"?ח/.test(title);
}

function looksRoomsOnlyTitle(title) {
  if (typeof title !== 'string') return false;
  return /^\d+(?:\.\d+)?\s*(?:חד׳|חדר(?:ים)?)$/.test(title.trim());
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/scrub-poison-state.js <seen-ads.json>');
    process.exit(2);
  }
  if (!fs.existsSync(target)) {
    console.error(`file not found: ${target}`);
    process.exit(2);
  }
  const raw = fs.readFileSync(target, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data.ads !== 'object') {
    console.error('seen-ads.json is missing the `ads` object');
    process.exit(2);
  }
  let scrubbedWidget = 0;
  let scrubbedAntiBot = 0;
  let scrubbedPricePlaceholder = 0;
  let scrubbedAgencyTitle = 0;
  let scrubbedAddressLikeCity = 0;
  let healedPriceFromTitle = 0;
  let healedRoomsFromTitle = 0;
  let resetTitle = 0;
  let recoveredCityFromTitle = 0;
  let nulledForRescrape = 0;
  for (const [id, record] of Object.entries(data.ads)) {
    let touched = false;

    if (isErrorWidget(record.city)) {
      record.city = null;
      scrubbedWidget += 1;
      touched = true;
    }
    if (isErrorWidget(record.title)) {
      record.title = 'מודעה';
      touched = true;
    }

    // Anti-bot challenge text leaked into city/title.
    if (isAntiBotText(record.city)) {
      record.city = null;
      scrubbedAntiBot += 1;
      touched = true;
    }
    if (isAntiBotText(record.title)) {
      record.title = 'מודעה';
      touched = true;
    }

    // "לא צוין מחיר" placeholder leaked into title from the price area.
    if (isPricePlaceholderText(record.title)) {
      record.title = 'מודעה';
      scrubbedPricePlaceholder += 1;
      touched = true;
    }
    if (isPricePlaceholderText(record.city)) {
      record.city = null;
      scrubbedPricePlaceholder += 1;
      touched = true;
    }

    // Address-like value leaked into city: "383 1", "הרקפת 162",
    // "נחל איילון 20" - these are streets, not cities. Wipe so the
    // heal step re-enriches.
    if (typeof record.city === 'string' && /\d/.test(record.city)) {
      record.city = null;
      scrubbedAddressLikeCity += 1;
      touched = true;
    }
    // Agency / realtor wording inside the city field - same treatment.
    if (looksLikeAgencyTitle(record.city)) {
      record.city = null;
      scrubbedAgencyTitle += 1;
      touched = true;
    }

    // Agency / realtor name leaked into the title from a sponsored
    // list-card. Only reset when the title clearly matches one of
    // the agency wording patterns AND it doesn't ALSO look like a
    // property heading (e.g. "דירה, חיפה"). Without this guardrail
    // we'd risk wiping real titles that incidentally contain words
    // like "תיווך" inside a longer phrase.
    if (typeof record.title === 'string') {
      const t = record.title;
      const looksAgency = looksLikeAgencyTitle(t);
      const looksProperty = looksLikePropertyTitle(t);
      if (looksAgency && !looksProperty) {
        record.title = 'מודעה';
        scrubbedAgencyTitle += 1;
        touched = true;
      }
    }

    // Promotional / generic words that sometimes leak into titles.
    if (typeof record.title === 'string') {
      const t = record.title.trim();
      const promoExact = new Set([
        'בלעדי',
        'מבצע',
        'מקצועי',
        'חדש',
        'מומלץ',
        'intact'
      ]);
      const promoContains = /^שדרת המתווכ|^שיל\"ת|^שיל״ת/;
      if (promoExact.has(t) || promoContains.test(t)) {
        record.title = 'מודעה';
        scrubbedAgencyTitle += 1;
        touched = true;
      }
    }

    // Property-type-only titles ("דירה", "בית פרטי/ קוטג'") with no
    // city are not informative; the heal step needs another shot.
    const cityIsBlank2 = typeof record.city !== 'string' || record.city.trim().length === 0;
    if (cityIsBlank2 && isPropertyTypeOnlyTitle(record.title)) {
      record.title = 'מודעה';
      scrubbedAgencyTitle += 1;
      touched = true;
    }

    // City is missing AND the existing title is a street address
    // (e.g. "הרקפת 162", "שדרות אילות 1"). Without a real city the
    // dashboard would render the street as the headline. Reset to
    // the neutral placeholder so the heal step (which now has the
    // homepage warmup) can re-enrich it.
    const cityIsBlank = typeof record.city !== 'string' || record.city.trim().length === 0;
    if (
      cityIsBlank &&
      typeof record.title === 'string' &&
      /\d/.test(record.title) &&
      !looksLikePropertyTitle(record.title) &&
      !isErrorWidget(record.title) &&
      !isAntiBotText(record.title) &&
      record.title !== 'מודעה' &&
      record.title !== 'מודעה ללא כותרת'
    ) {
      record.title = 'מודעה';
      resetTitle += 1;
      touched = true;
    }

    // Heal a price hidden inside the title.
    if ((record.price === null || record.price === undefined) && looksPriceLikeTitle(record.title)) {
      const parsed = parsePriceFromTitle(record.title);
      if (parsed !== null) {
        record.price = parsed;
        healedPriceFromTitle += 1;
        touched = true;
      }
    }

    // Heal rooms hidden inside the title.
    if ((record.rooms === null || record.rooms === undefined) && looksRoomsOnlyTitle(record.title)) {
      const parsed = parseRoomsFromTitle(record.title);
      if (parsed !== null) {
        record.rooms = parsed;
        healedRoomsFromTitle += 1;
        touched = true;
      }
    }

    // Once we've extracted any structured info, neutralise the title
    // so the dashboard headline doesn't render the price string.
    if (looksPriceLikeTitle(record.title) || looksRoomsOnlyTitle(record.title)) {
      record.title = 'מודעה';
      resetTitle += 1;
      touched = true;
    }

    // Recover city from a "PROPERTY_TYPE, CITY" title when the record
    // has a clean title but a missing city. Common shape:
    //   { title: "דירה, נחושה", city: null } → city: "נחושה".
    // We deliberately accept the recovered value only when it looks
    // like a real city name (no digits, no agency words).
    {
      const cityBlank = typeof record.city !== 'string' || record.city.trim().length === 0;
      if (
        cityBlank &&
        typeof record.title === 'string' &&
        record.title.includes(',') &&
        !isPoisonText(record.title) &&
        !looksLikeAgencyTitle(record.title)
      ) {
        const candidate = record.title.slice(record.title.indexOf(',') + 1).trim();
        const looksClean =
          candidate.length > 0 &&
          candidate.length <= 40 &&
          !/\d/.test(candidate) &&
          !looksLikeAgencyTitle(candidate);
        if (looksClean) {
          record.city = candidate;
          recoveredCityFromTitle += 1;
          touched = true;
        }
      }
    }

    // Final pass: if AFTER all the scrubbing the record still has
    // `title === "מודעה"` AND `city === null`, the next live list-card
    // scrape is the only source that can repair it. Setting both to
    // null forces preferFreshField in commitAds to accept whatever
    // the next scrape produces. We do NOT delete the record (it might
    // already be a known new-ad we'd otherwise re-notify on).
    {
      const cityBlank = typeof record.city !== 'string' || record.city.trim().length === 0;
      const titlePlaceholder =
        record.title === 'מודעה' || record.title === 'מודעה ללא כותרת';
      if (cityBlank && titlePlaceholder) {
        record.city = null;
        record.title = null;
        nulledForRescrape += 1;
        touched = true;
      }
    }

    if (touched) {
      data.ads[id] = record;
    }
  }
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    [
      `widget=${scrubbedWidget}`,
      `anti-bot=${scrubbedAntiBot}`,
      `price-placeholder=${scrubbedPricePlaceholder}`,
      `address-like-city=${scrubbedAddressLikeCity}`,
      `agency-title=${scrubbedAgencyTitle}`,
      `healed-price-from-title=${healedPriceFromTitle}`,
      `healed-rooms-from-title=${healedRoomsFromTitle}`,
      `neutralised-titles=${resetTitle}`,
      `recovered-city-from-title=${recoveredCityFromTitle}`,
      `nulled-for-rescrape=${nulledForRescrape}`
    ].join(' ')
  );
}

main();
