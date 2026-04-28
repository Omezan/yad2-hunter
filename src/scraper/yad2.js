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

async function readExpectedCount(page) {
  return page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('h1, h2, [class*="results"], [data-testid*="results"]')
    );
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').trim();
      const match = text.match(/(\d{1,4})\s*תוצאות?/);
      if (match) {
        return Number.parseInt(match[1], 10);
      }
    }
    const body = (document.body && document.body.innerText) || '';
    const match = body.match(/(\d{1,4})\s*תוצאות?/);
    return match ? Number.parseInt(match[1], 10) : null;
  });
}

async function countDistrictItemAnchors(page) {
  return page.evaluate(() => {
    const seen = new Set();
    document.querySelectorAll('a[href*="/realestate/item/"]').forEach((a) => {
      const match = (a.href || '').match(
        /\/realestate\/item\/[a-z][a-z-]+\/[a-z0-9]+/i
      );
      if (match) seen.add(match[0]);
    });
    return seen.size;
  });
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

async function detectCaptcha(page) {
  return page.evaluate(() => {
    const title = (document.title || '').toLowerCase();
    if (title.includes('shieldsquare') || title.includes('captcha')) return true;
    if (title.includes('radware') || title.includes('bot manager block')) return true;
    const body = (document.body && document.body.innerText) || '';
    return /are you for real|אבטחת אתר|captcha digest|radware|bot manager block|מסיבות אבטחה והגנה על האתר|incident id/i.test(
      body
    );
  });
}

async function scrapeSearchPage(page, url, timeoutMs, { attempts = 2, logger = console } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });

    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null);

    if (await detectCaptcha(page)) {
      logger.warn?.(`  captcha challenge on ${url} (attempt ${attempt}/${attempts})`);
      if (attempt < attempts) {
        await page.waitForTimeout(4000 + Math.floor(Math.random() * 3000));
        continue;
      }
      return { anchors: [], expectedCount: null };
    }

    const hasItems = await page
      .waitForSelector('a[href*="/realestate/item/"]', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (!hasItems) {
      const diagnostics = await page.evaluate(() => ({
        title: document.title,
        hasItemAnchors: document.querySelectorAll('a[href*="/realestate/item/"]').length,
        hasNoResults: /אין תוצאות|לא נמצאו/.test(
          document.body && document.body.innerText ? document.body.innerText : ''
        ),
        firstBodySnippet: ((document.body && document.body.innerText) || '').slice(0, 200)
      }));
      logger.warn?.(
        `  no items on ${url} (attempt ${attempt}/${attempts}): ${JSON.stringify(diagnostics)}`
      );
      if (attempt < attempts) {
        await page.waitForTimeout(2000);
        continue;
      }
      return { anchors: [], expectedCount: null };
    }

    const expectedCount = await readExpectedCount(page);
    const allAnchors = [];
    const seenAnchors = new Set();
    const seenDistrictIds = new Set();

    async function pushAnchorsFromCurrentPage() {
      const anchors = await extractAnchorsFromPage(page);
      let added = 0;
      for (const a of anchors) {
        if (!a.href || seenAnchors.has(a.href)) continue;
        seenAnchors.add(a.href);
        allAnchors.push(a);
        added += 1;
        const districtMatch = a.href.match(/\/realestate\/item\/[a-z][a-z-]+\/[a-z0-9]+/i);
        if (districtMatch) {
          seenDistrictIds.add(districtMatch[0]);
        }
      }
      return added;
    }

    function cumulativeDistrictNeedsMore() {
      if (typeof expectedCount !== 'number') return false;
      return seenDistrictIds.size < expectedCount;
    }

    async function safeScrollAndExtract() {
      const maxAttempts = 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await scrollPageOnce(page);
          return await pushAnchorsFromCurrentPage();
        } catch (error) {
          const isNavRace = /Execution context was destroyed|Target closed|navigation/i.test(
            error.message || ''
          );
          if (!isNavRace || attempt === maxAttempts) {
            throw error;
          }
          logger.warn?.(
            `    scroll/extract attempt ${attempt} hit navigation race: ${error.message}; settling and retrying`
          );
          await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => null);
          await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null);
        }
      }
      return 0;
    }

    await safeScrollAndExtract();
    logger.info?.(
      `    page 1: ${seenAnchors.size} anchors (district=${seenDistrictIds.size}, expected=${expectedCount ?? '?'})`
    );

    let pageIndex = 1;
    const maxPages = 10;
    while (pageIndex < maxPages && cumulativeDistrictNeedsMore()) {
      const advanced = await goToNextPage(page, pageIndex + 1, logger);
      if (!advanced) break;

      pageIndex += 1;
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null);

      const added = await safeScrollAndExtract();
      logger.info?.(
        `    page ${pageIndex}: +${added} anchors (total=${seenAnchors.size}, district=${seenDistrictIds.size})`
      );
      if (added === 0) break;
    }

    return { anchors: allAnchors, expectedCount };
  }
  return { anchors: [], expectedCount: null };
}

async function scrollPageOnce(page) {
  await page.evaluate(async () => {
    const stepSize = Math.max(window.innerHeight, 600);
    const steps = 10;
    for (let i = 0; i < steps; i += 1) {
      window.scrollBy(0, stepSize);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
}

async function goToNextPage(page, targetPageNumber, logger) {
  const beforeFirstId = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/realestate/item/"]');
    return a ? a.href : null;
  });

  const clickResult = await page.evaluate((target) => {
    const all = Array.from(
      document.querySelectorAll(
        'a[aria-label*="עמוד"], button[aria-label*="עמוד"], a[aria-label*="הבא"], button[aria-label*="הבא"], [role="navigation"] a, [role="navigation"] button, nav a, nav button, [class*="pagination"] a, [class*="pagination"] button, [class*="pager"] a, [class*="pager"] button'
      )
    );
    function getText(el) {
      return ((el.innerText || el.textContent) || '').trim();
    }
    function isNumberAnchor(el, num) {
      const text = getText(el);
      return text === String(num);
    }
    const numericTarget = all.find((el) => isNumberAnchor(el, target));
    if (numericTarget) {
      numericTarget.scrollIntoView({ block: 'center' });
      numericTarget.click();
      return `numeric:${target}`;
    }
    const nextArrow = all.find((el) => {
      const label = (el.getAttribute('aria-label') || '').trim();
      return /הבא|next/i.test(label);
    });
    if (nextArrow && !nextArrow.disabled && nextArrow.getAttribute('aria-disabled') !== 'true') {
      nextArrow.scrollIntoView({ block: 'center' });
      nextArrow.click();
      return 'next-arrow';
    }
    return null;
  }, targetPageNumber);

  let advancedVia = clickResult;

  if (advancedVia) {
    const changed = await page
      .waitForFunction(
        (prevId) => {
          const a = document.querySelector('a[href*="/realestate/item/"]');
          return a && a.href !== prevId;
        },
        beforeFirstId,
        { timeout: 8000 }
      )
      .then(() => true)
      .catch(() => false);

    if (!changed) {
      logger.warn?.(`    pager: page ${targetPageNumber} did not change after click (${clickResult}); will fallback to direct navigation`);
      advancedVia = null;
    }
  }

  if (!advancedVia) {
    const currentUrl = page.url();
    const fallbackUrl = (() => {
      try {
        const u = new URL(currentUrl);
        u.searchParams.set('page', String(targetPageNumber));
        return u.toString();
      } catch {
        return null;
      }
    })();

    if (!fallbackUrl) {
      logger.warn?.(`    pager: could not build fallback URL for page ${targetPageNumber}`);
      return false;
    }

    try {
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null);
      const hasItems = await page
        .waitForSelector('a[href*="/realestate/item/"]', { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (!hasItems) {
        logger.warn?.(`    pager: fallback ${fallbackUrl} returned no items`);
        return false;
      }
      advancedVia = `direct:${fallbackUrl}`;
    } catch (error) {
      logger.warn?.(`    pager: fallback to ${fallbackUrl} failed: ${error.message}`);
      return false;
    }
  }

  logger.info?.(`    pager: advanced to page ${targetPageNumber} via ${advancedVia}`);
  return true;
}

const DISTRICT_ITEM_URL_RE = /\/realestate\/item\/[a-z][a-z-]+\/[a-z0-9]+/i;

async function scrapeSearch(page, search, timeoutMs, { logger = console } = {}) {
  const { anchors, expectedCount } = await scrapeSearchPage(page, search.url, timeoutMs, {
    logger
  });

  const collected = new Map();
  let suggestionCount = 0;

  for (const entry of anchors) {
    if (!entry.href || !/\/realestate\/item\//i.test(entry.href)) continue;
    if (!DISTRICT_ITEM_URL_RE.test(entry.href)) {
      suggestionCount += 1;
      continue;
    }
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
      expectedCount,
      scrapedAt: new Date().toISOString()
    });
  }

  let ads = Array.from(collected.values());
  if (typeof expectedCount === 'number' && ads.length > expectedCount) {
    logger.warn?.(
      `  ${search.id}: scraped ${ads.length} but expected ${expectedCount}, trimming to expected`
    );
    ads = ads.slice(0, expectedCount);
  }

  logger.info?.(
    `  ${search.id}: real=${ads.length}, suggestions-skipped=${suggestionCount}, expected=${expectedCount ?? '?'}`
  );

  return {
    ads,
    expectedCount,
    uniqueOnPage: collected.size
  };
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

    function findPublishedText() {
      const labelMatchers = [
        '[data-testid*="updated"]',
        '[data-testid*="published"]',
        '[class*="updated"]',
        '[class*="published"]',
        '[class*="report-info"]'
      ];
      for (const selector of labelMatchers) {
        const el = document.querySelector(selector);
        if (el) {
          const text = (el.innerText || el.textContent || '').trim();
          if (/פורסם/.test(text) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text)) {
            return text;
          }
        }
      }
      const all = (document.body && document.body.innerText) || '';
      const match = all.match(/פורסם\s+ב[^\n]*\d{1,2}\/\d{1,2}\/\d{2,4}/);
      return match ? match[0].trim() : '';
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
      publishedText: findPublishedText(),
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
  const publishedText = String(data.publishedText || '').replace(/[\u200e\u200f]/g, '');
  const publishedAt = parsePublishedDate(publishedText) || parsePublishedDate(cleanText);

  return {
    url,
    title: buildListingTitle({ propertyType, city }),
    propertyType,
    city,
    addressText,
    descriptionText,
    publishedText,
    publishedAt,
    rooms: Number.isFinite(rooms) ? rooms : null,
    price,
    hasExplicitPrice: !noPriceHint && price !== null
  };
}

function parsePublishedDate(text) {
  if (!text) return null;
  const match = String(text).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!match) return null;

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  let year = Number.parseInt(match[3], 10);
  if (year < 100) year += 2000;

  if (!day || !month || !year || day > 31 || month > 12) return null;

  const iso = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (Number.isNaN(iso.getTime())) return null;
  return iso.toISOString().slice(0, 10);
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

async function warmUpSession(page, timeoutMs, logger) {
  try {
    await page.goto('https://www.yad2.co.il/', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
  } catch (error) {
    logger.warn?.(`Warm-up failed (continuing anyway): ${error.message}`);
  }
}

const BROWSER_PROFILES = [
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1200 }
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 }
  },
  {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1536, height: 864 }
  }
];

async function scrapeBatchWithFreshBrowser({
  searches,
  headless,
  timeoutMs,
  logger,
  profile,
  extraWarmupMs = 0
}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: profile.userAgent,
    locale: 'he-IL',
    viewport: profile.viewport,
    extraHTTPHeaders: {
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  const page = await context.newPage();
  const ads = [];
  const errors = [];
  const empty = [];

  try {
    await warmUpSession(page, timeoutMs, logger);
    if (extraWarmupMs > 0) {
      await page.waitForTimeout(extraWarmupMs + Math.floor(Math.random() * 2000));
    }

    for (let i = 0; i < searches.length; i += 1) {
      const search = searches[i];
      try {
        if (i > 0) {
          await page.waitForTimeout(2000 + Math.floor(Math.random() * 2500));
        }
        logger.info(`Checking ${search.label}: ${search.url}`);
        let result = await scrapeSearch(page, search, timeoutMs, { logger });
        if (result.ads.length === 0) {
          logger.warn?.(
            `  ${search.id}: empty result on first attempt; warming up and retrying once`
          );
          await warmUpSession(page, timeoutMs, logger);
          await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
          result = await scrapeSearch(page, search, timeoutMs, { logger });
        }
        logger.info(`  ${search.id} total: ${result.ads.length}`);
        if (result.ads.length === 0) {
          empty.push(search);
        } else {
          ads.push(...result.ads);
        }
      } catch (error) {
        logger.error(`Failed scraping ${search.id}: ${error.message}`);
        errors.push({
          searchId: search.id,
          searchLabel: search.label,
          message: error.message
        });
        empty.push(search);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return { ads, errors, empty };
}

async function scrapeAllSearches({ searches, headless = true, timeoutMs = 60000, logger = console }) {
  const allAds = [];
  const allErrors = [];

  const firstPass = await scrapeBatchWithFreshBrowser({
    searches,
    headless,
    timeoutMs,
    logger,
    profile: BROWSER_PROFILES[0]
  });

  allAds.push(...firstPass.ads);
  allErrors.push(...firstPass.errors);

  let pendingEmpty = firstPass.empty;
  let profileIndex = 1;

  while (pendingEmpty.length > 0 && profileIndex < BROWSER_PROFILES.length) {
    const profile = BROWSER_PROFILES[profileIndex];
    logger.warn?.(
      `Retrying ${pendingEmpty.length} blocked/empty searches (${pendingEmpty
        .map((s) => s.id)
        .join(', ')}) with fresh browser profile #${profileIndex + 1}`
    );

    const retryPass = await scrapeBatchWithFreshBrowser({
      searches: pendingEmpty,
      headless,
      timeoutMs,
      logger,
      profile,
      extraWarmupMs: 5000
    });

    allAds.push(...retryPass.ads);
    allErrors.push(...retryPass.errors);
    pendingEmpty = retryPass.empty;
    profileIndex += 1;
  }

  if (pendingEmpty.length > 0) {
    for (const search of pendingEmpty) {
      logger.error(
        `  ${search.id}: still blocked after ${profileIndex} fresh-browser retries; giving up for this run`
      );
      allErrors.push({
        searchId: search.id,
        searchLabel: search.label,
        message: 'blocked by anti-bot after all retries'
      });
    }
  }

  return {
    ads: dedupeByExternalId(allAds),
    errors: allErrors
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

  async function fetchWithRetry(page, ad) {
    const maxAttempts = 2;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fetchListingDetails(page, ad.link, timeoutMs);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          logger.warn?.(
            `  detail fetch attempt ${attempt}/${maxAttempts} failed for ${ad.link}: ${error.message}`
          );
          await page.waitForTimeout(1200 + Math.floor(Math.random() * 800));
        }
      }
    }
    throw lastError;
  }

  async function worker(page) {
    while (queue.length) {
      if (Date.now() >= deadline) {
        logger.warn?.('Enrichment budget exhausted, stopping early');
        break;
      }
      const ad = queue.shift();
      if (!ad) break;
      try {
        const details = await fetchWithRetry(page, ad);
        enriched.push({
          ...ad,
          title: details.title || ad.title,
          city: details.city,
          propertyType: details.propertyType,
          addressText: details.addressText,
          descriptionText: details.descriptionText,
          publishedText: details.publishedText,
          publishedAt: details.publishedAt,
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
  parsePublishedDate,
  scrapeAllSearches
};
