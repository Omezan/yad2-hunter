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

function buildPageUrl(baseUrl, pageNumber) {
  if (pageNumber <= 1) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set('page', String(pageNumber));
  return url.toString();
}

async function autoScrollToLoadAll(page, { maxPasses = 25, idlePassLimit = 2 } = {}) {
  let lastCount = 0;
  let idlePasses = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const count = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.querySelectorAll('a[href*="/realestate/item/"]').length;
    });

    if (count === lastCount) {
      idlePasses += 1;
      if (idlePasses >= idlePassLimit) {
        break;
      }
    } else {
      idlePasses = 0;
      lastCount = count;
    }

    await page.waitForTimeout(450);
  }
}

async function extractAnchorsFromPage(page) {
  return page.$$eval('a[href*="/realestate/item/"]', (anchors) =>
    anchors.map((anchor) => {
      const container =
        anchor.closest('article') ||
        anchor.closest('li') ||
        anchor.closest('[class*="feed-item"]') ||
        anchor.closest('[class*="feed_item"]') ||
        anchor.closest('[class*="card"]');

      return {
        href: anchor.href || '',
        text: anchor.innerText || anchor.textContent || '',
        containerText:
          container?.innerText || container?.textContent || anchor.innerText || anchor.textContent || ''
      };
    })
  );
}

async function scrapeSearchPage(page, url, timeoutMs) {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs
  });

  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null);

  const hasItems = await page
    .waitForSelector('a[href*="/realestate/item/"]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (!hasItems) {
    return [];
  }

  await autoScrollToLoadAll(page, { maxPasses: 12, idlePassLimit: 2 });

  return extractAnchorsFromPage(page);
}

async function scrapeSearch(page, search, timeoutMs, { maxPages = 6 } = {}) {
  const collected = new Map();
  let consecutiveEmptyOrDuplicate = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = buildPageUrl(search.url, pageNumber);
    const rawAds = await scrapeSearchPage(page, url, timeoutMs);

    if (!rawAds.length) {
      break;
    }

    const sizeBefore = collected.size;

    for (const entry of rawAds) {
      if (!entry.href || !/\/realestate\/item\//i.test(entry.href)) continue;
      const normalizedLink = normalizeItemUrl(entry.href);
      const externalId = extractExternalId(normalizedLink);
      if (!externalId || collected.has(externalId)) continue;

      const rawText = String(entry.containerText || entry.text || '').trim();
      collected.set(externalId, {
        externalId,
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
        scrapedAt: new Date().toISOString()
      });
    }

    const newOnThisPage = collected.size - sizeBefore;
    if (newOnThisPage === 0) {
      consecutiveEmptyOrDuplicate += 1;
      if (consecutiveEmptyOrDuplicate >= 2) {
        break;
      }
    } else {
      consecutiveEmptyOrDuplicate = 0;
    }
  }

  return Array.from(collected.values());
}

async function fetchListingDetails(page, url, timeoutMs) {
  const navigation = page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs
  });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('detail fetch timeout')), timeoutMs)
  );

  await Promise.race([navigation, timeoutPromise]);

  const data = await page.evaluate(() => {
    function textOf(selector) {
      const el = document.querySelector(selector);
      return el ? (el.innerText || el.textContent || '').trim() : '';
    }

    function findDescriptionText() {
      const selectors = [
        '[data-testid*="description"]',
        '[data-testid*="Description"]',
        '[class*="description"]',
        '[class*="Description"]',
        '[class*="property-text"]',
        '[class*="propertyText"]',
        '[itemprop="description"]'
      ];
      const blocks = new Set();
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          const text = (el.innerText || el.textContent || '').trim();
          if (text && text.length >= 20 && text.length <= 4000) {
            blocks.add(text);
          }
        });
      }
      return Array.from(blocks).join('\n').trim();
    }

    function findAddressText() {
      const candidates = [
        '[data-testid*="address"]',
        '[class*="address"]',
        '[class*="location"]',
        '[itemprop="address"]'
      ];
      for (const selector of candidates) {
        const el = document.querySelector(selector);
        if (el) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text) return text;
        }
      }
      return '';
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
      addressText: findAddressText(),
      descriptionText: findDescriptionText(),
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
  const descriptionText = String(data.descriptionText || '').replace(/[\u200e\u200f]/g, '');
  const addressText = String(data.addressText || '').replace(/[\u200e\u200f]/g, '');

  return {
    url,
    title: buildListingTitle({ propertyType, city }),
    propertyType,
    city,
    addressText,
    descriptionText,
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

async function enrichAdsWithDetails({
  ads,
  headless = true,
  timeoutMs = 12000,
  concurrency = 4,
  budgetMs = 0,
  logger = console
}) {
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

  const pages = await Promise.all(
    Array.from({ length: Math.min(concurrency, ads.length) }, () => context.newPage())
  );

  const queue = ads.slice();
  const enriched = [];
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;

  async function worker(page) {
    while (queue.length) {
      if (Date.now() >= deadline) {
        logger.warn?.('Enrichment budget exhausted, stopping early');
        break;
      }
      const ad = queue.shift();
      if (!ad) break;
      try {
        const details = await fetchListingDetails(page, ad.link, timeoutMs);
        enriched.push({
          ...ad,
          title: details.title || ad.title,
          city: details.city,
          propertyType: details.propertyType,
          addressText: details.addressText,
          descriptionText: details.descriptionText,
          rawText: '',
          rooms: details.rooms ?? ad.rooms,
          price: details.price ?? ad.price,
          hasExplicitPrice: details.hasExplicitPrice,
          enriched: true
        });
      } catch (error) {
        logger.error(`Failed fetching details for ${ad.link}: ${error.message}`);
        enriched.push({ ...ad, hasExplicitPrice: false, enriched: false });
      }
    }
  }

  try {
    await Promise.all(pages.map((page) => worker(page)));
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
