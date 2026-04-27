const { chromium } = require('playwright');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function normalizeItemUrl(rawUrl) {
  if (!rawUrl) {
    return '';
  }

  const parsedUrl = new URL(rawUrl);
  parsedUrl.hash = '';
  parsedUrl.search = '';
  return parsedUrl.toString().replace(/\/$/, '');
}

function extractExternalId(url) {
  const normalizedUrl = normalizeItemUrl(url);
  const match = normalizedUrl.match(/\/realestate\/item\/(.+)$/i);
  if (match) {
    return match[1].replace(/\/$/, '');
  }

  const parsedUrl = new URL(normalizedUrl);
  return parsedUrl.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || normalizedUrl;
}

function parsePrice(text) {
  const match = String(text || '').match(/([\d,.]+)\s*[₪]/);
  if (!match) {
    return null;
  }

  const numericValue = Number.parseInt(match[1].replace(/[^\d]/g, ''), 10);
  return Number.isNaN(numericValue) ? null : numericValue;
}

function parseRooms(text) {
  const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*(?:חד׳|חדר(?:ים)?)/i);
  if (!match) {
    return null;
  }

  const rooms = Number.parseFloat(match[1]);
  return Number.isNaN(rooms) ? null : rooms;
}

function extractTitle(rawText) {
  const lines = String(rawText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[0] || 'מודעה ללא כותרת';
}

function extractLocation(rawText) {
  const lines = String(rawText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[1] || '';
}

function dedupeByExternalId(ads) {
  const deduped = new Map();

  for (const ad of ads) {
    deduped.set(ad.externalId, ad);
  }

  return Array.from(deduped.values());
}

async function scrapeSearch(page, search, timeoutMs) {
  await page.goto(search.url, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs
  });

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
  await page.waitForSelector('a[href*="/item/"]', { timeout: 15000 });

  const rawAds = await page.$$eval('a[href*="/item/"]', (anchors) =>
    anchors.map((anchor) => {
      const container =
        anchor.closest('article') ||
        anchor.closest('li') ||
        anchor.closest('[class*="feed"]') ||
        anchor.closest('[class*="item"]');

      return {
        href: anchor.href || '',
        text: anchor.innerText || anchor.textContent || '',
        containerText:
          container?.innerText || container?.textContent || anchor.innerText || anchor.textContent || ''
      };
    })
  );

  const scrapedAt = new Date().toISOString();

  return rawAds
    .filter((entry) => entry.href && /\/realestate\/item\//i.test(entry.href))
    .map((entry) => {
      const normalizedLink = normalizeItemUrl(entry.href);
      const rawText = String(entry.containerText || entry.text || '').trim();

      return {
        externalId: extractExternalId(normalizedLink),
        title: extractTitle(rawText),
        link: normalizedLink,
        rawText,
        locationText: extractLocation(rawText),
        districtKey: search.districtKey,
        districtLabel: search.districtLabel,
        searchId: search.id,
        searchLabel: search.label,
        sourceUrl: search.url,
        settlementsOnly: Boolean(search.settlementsOnly),
        price: parsePrice(rawText),
        rooms: parseRooms(rawText),
        scrapedAt
      };
    })
    .filter((ad) => ad.externalId && ad.link);
}

async function fetchListingDetails(page, url, timeoutMs) {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs
  });

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);

  const data = await page.evaluate(() => {
    function textOf(selector) {
      const el = document.querySelector(selector);
      return el ? (el.innerText || el.textContent || '').trim() : '';
    }

    const titleHeading = textOf('h1') || textOf('h2');
    const subTitle =
      textOf('[class*="property-type"]') ||
      textOf('[data-testid*="property-type"]') ||
      '';
    const allText =
      document.body && (document.body.innerText || document.body.textContent)
        ? document.body.innerText
        : '';

    return {
      titleHeading,
      subTitle,
      allText
    };
  });

  const text = String(data.allText || '');
  const cleanText = text.replace(/[\u200e\u200f]/g, '');

  const priceMatch = cleanText.match(/([\d.,]+)\s*₪/);
  const priceNumeric = priceMatch
    ? Number.parseInt(priceMatch[1].replace(/[^\d]/g, ''), 10)
    : null;
  const price = Number.isFinite(priceNumeric) ? priceNumeric : null;

  const noPriceHint = /לא צוין מחיר/.test(cleanText);

  const roomsMatch = cleanText.match(/(\d+(?:\.\d+)?)\s*חדרים/);
  const rooms = roomsMatch ? Number.parseFloat(roomsMatch[1]) : null;

  const propertyType = data.subTitle || guessPropertyType(cleanText);
  const city = (data.titleHeading || '').split('\n')[0].trim() || null;

  return {
    url,
    title: buildListingTitle({ propertyType, city }),
    propertyType,
    city,
    rooms: Number.isFinite(rooms) ? rooms : null,
    price,
    hasExplicitPrice: !noPriceHint && price !== null
  };
}

function guessPropertyType(text) {
  const candidates = [
    'בית פרטי/ קוטג\'',
    'דירה',
    'דירת גן',
    'דירת גג',
    'פנטהאוז',
    'יחידת דיור',
    'מיני פנטהאוז',
    'דופלקס',
    'טריפלקס',
    'וילה'
  ];
  for (const candidate of candidates) {
    if (text.includes(candidate)) {
      return candidate;
    }
  }
  return '';
}

function buildListingTitle({ propertyType, city }) {
  const parts = [propertyType, city].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'מודעה';
}

async function scrapeAllSearches({ searches, headless = true, timeoutMs = 60000, logger = console }) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    locale: 'he-IL',
    viewport: { width: 1440, height: 1200 },
    extraHTTPHeaders: {
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8'
    }
  });

  const page = await context.newPage();
  const allAds = [];
  const errors = [];

  try {
    for (const search of searches) {
      try {
        logger.info(`Checking ${search.label}: ${search.url}`);
        const ads = await scrapeSearch(page, search, timeoutMs);
        allAds.push(...ads);
      } catch (error) {
        logger.error(`Failed scraping ${search.id}: ${error.message}`);
        errors.push({
          searchId: search.id,
          searchLabel: search.label,
          message: error.message
        });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return {
    ads: dedupeByExternalId(allAds),
    errors
  };
}

async function enrichAdsWithDetails({ ads, headless = true, timeoutMs = 30000, logger = console }) {
  if (!ads.length) return ads;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    locale: 'he-IL',
    viewport: { width: 1440, height: 1200 },
    extraHTTPHeaders: {
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8'
    }
  });

  const page = await context.newPage();
  const enriched = [];

  try {
    for (const ad of ads) {
      try {
        const details = await fetchListingDetails(page, ad.link, timeoutMs);
        enriched.push({
          ...ad,
          title: details.title || ad.title,
          city: details.city,
          propertyType: details.propertyType,
          rooms: details.rooms ?? ad.rooms,
          price: details.price ?? ad.price,
          hasExplicitPrice: details.hasExplicitPrice
        });
      } catch (error) {
        logger.error(`Failed fetching details for ${ad.link}: ${error.message}`);
        enriched.push({ ...ad, hasExplicitPrice: false });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return enriched;
}

module.exports = {
  enrichAdsWithDetails,
  extractExternalId,
  fetchListingDetails,
  normalizeItemUrl,
  scrapeAllSearches
};
