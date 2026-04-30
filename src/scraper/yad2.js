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

// Hebrew property-type prefixes Yad2 uses on the "PROPERTY_TYPE, CITY"
// heading line of every list card. A line that starts with one of
// these AND contains a comma is the canonical heading we want.
const PROPERTY_TYPE_PREFIXES = [
  'בית פרטי/ קוטג\'',
  'בית פרטי / קוטג\'',
  'בית פרטי',
  'דירת גן',
  'דירת גג',
  'דירה',
  'פנטהאוז',
  'מיני פנטהאוז',
  'דופלקס',
  'טריפלקס',
  'יחידת דיור',
  'וילה',
  'משק',
  'סטודיו',
  'גג/ פנטהאוז',
  'גג / פנטהאוז',
  'דו משפחתי'
];

function startsWithPropertyType(line) {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  return PROPERTY_TYPE_PREFIXES.some(
    (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix},`) || trimmed.startsWith(`${prefix} `)
  );
}

// Yad2 list cards repeat the city in the heading line:
// "בית פרטי/ קוטג', אשלים, אשלים". Collapse "X, X" into "X" so
// downstream consumers see a clean "PROPERTY_TYPE, CITY" string.
function collapseDuplicatedTrailingSegment(line) {
  if (typeof line !== 'string') return line;
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    const secondToLast = parts[parts.length - 2];
    if (last && last === secondToLast) {
      return parts.slice(0, -1).join(', ');
    }
  }
  return line;
}

function shouldSkipTitleLine(line) {
  // Yad2 error widget.
  if (/אופס\.{2,3}\s*תקלה/.test(line)) return true;
  // Anti-bot / captcha challenge text.
  if (/are\s+you\s+for\s+real/i.test(line)) return true;
  if (/shieldsquare|radware|bot\s*manager\s*block/i.test(line)) return true;
  // "לא צוין מחיר" - belongs in the structured price field.
  if (/^\s*לא\s+צוין\s+מחיר\s*$/.test(line)) return true;
  // Pure price strings ("₪ 5,300", "5300 ₪", "ירד ב-500 ₪").
  if (/^\s*[₪]?\s*[\d.,]+\s*[₪]?\s*$/.test(line)) return true;
  if (/^\s*ירד\s+ב/.test(line) && /₪/.test(line)) return true;
  // Rooms-only line.
  if (/^\d+(?:\.\d+)?\s*(?:חד׳|חדר(?:ים)?)$/.test(line)) return true;
  // Realtor / agency / sponsored brand line.
  if (/נדל[״"']?ן/i.test(line)) return true;
  if (/RE\/?MAX|UNISTATE|REAL\s+ESTATE|REALTY|REALITY/i.test(line)) return true;
  if (/תיווך|נכסים|יזמות|שיווק נדל|קפיטל/.test(line)) return true;
  // Pure Latin all-caps brand strings.
  if (/^[A-Z][A-Z0-9 +\-/]{2,}$/.test(line)) return true;
  return false;
}

function extractTitle(rawText) {
  const lines = String(rawText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  // First pass: prefer a "PROPERTY_TYPE, CITY[, CITY]" line. Yad2's
  // list cards always contain one of these and it's the only line
  // that reliably carries the city. Without this preference we'd
  // pick up the street-address line ("דרך האתרוג 59") or the
  // rooms/floor line as the title.
  for (const line of lines) {
    if (shouldSkipTitleLine(line)) continue;
    if (startsWithPropertyType(line) && line.includes(',')) {
      return collapseDuplicatedTrailingSegment(line);
    }
  }

  // Fallback: first non-skipped line (legacy behaviour). This
  // covers cards whose heading line is unusual but is still the
  // first descriptive content.
  for (const line of lines) {
    if (shouldSkipTitleLine(line)) continue;
    return line;
  }
  return 'מודעה ללא כותרת';
}

function extractLocation(rawText) {
  const lines = String(rawText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[1] || '';
}

// Yad2 list cards put the property heading on a single line shaped
// like "PROPERTY_TYPE, CITY" - e.g. "דירה, נחושה" - or with the
// city duplicated on sponsored cards: "בית פרטי/ קוטג', אשלים, אשלים".
// This helper walks the comma-separated segments from the END
// backward and returns the FIRST one that looks like a real city,
// so we accept both shapes uniformly without ever picking up the
// property type as the city.
function parseCityFromTitle(title) {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (!trimmed) return null;
  if (isYad2ErrorText(trimmed)) return null;
  if (!trimmed.includes(',')) return null;
  const segments = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // The first segment is always the property type ("דירה" /
  // "בית פרטי/ קוטג'"). Walk segments 2..N and return the first
  // city-shaped one (handles both "דירה, נחושה" and
  // "בית פרטי/ קוטג', אשלים, אשלים").
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    if (looksLikeCity(segments[i])) return segments[i];
  }
  return null;
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
    // Yad2's anti-bot challenge sets the document title to literally
    // "Are you for real?" while the body may not yet contain that text
    // (challenge text is rendered later by JS). Catch it from the title
    // alone so we never proceed to extract fields from a blocked page.
    if (title.includes('are you for real')) return true;
    const body = (document.body && document.body.innerText) || '';
    return /are you for real|אבטחת אתר|captcha digest|radware|bot manager block|מסיבות אבטחה והגנה על האתר|incident id/i.test(
      body
    );
  });
}

async function detectErrorPage(page) {
  return page.evaluate(() => {
    const title = ((document.title || '') + '').trim().toLowerCase();
    const body = (document.body && document.body.innerText) || '';
    const bodyText = body.trim();
    if (!bodyText) return true;

    const errorPatterns = [
      /^bad request($|[\s:])/i,
      /^400 bad request/i,
      /^page not found/i,
      /^not found/i,
      /^404/,
      /^500/,
      /^internal server error/i,
      /^service unavailable/i,
      /^gateway timeout/i
    ];
    if (errorPatterns.some((re) => re.test(title))) {
      return true;
    }

    // Yad2's "אופס... תקלה!" can show in two flavors:
    //   (a) the full-page error placeholder (short body),
    //   (b) a soft-error widget rendered INSIDE the listing layout
    //       while the rest of the page chrome stays normal — body is
    //       long, no 4xx/5xx status, but the listing data is missing.
    // Treat any visible "אופס... תקלה" as a hard error so we never
    // persist its text into the listing record.
    const hasOopsWidget = /אופס\.{2,3}\s*תקלה/.test(bodyText);
    if (hasOopsWidget) {
      // If the page also has a real listing heading (an address or a
      // price block), it's borderline — treat as error anyway because
      // we can't safely tell which fields are real vs. placeholder.
      return true;
    }

    if (
      bodyText.length < 500 &&
      /bad request|not found|internal server error|service unavailable/i.test(bodyText)
    ) {
      return true;
    }

    return false;
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
    const title = extractTitle(rawText);
    const city = parseCityFromTitle(title);
    collected.set(externalId, {
      externalId,
      title,
      city,
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

  // Yad2's Next.js SSR ships the listing data in __NEXT_DATA__ before
  // any anti-bot widget can mutate the DOM. If that script is present
  // and parses, the listing is real - skip the captcha early-throw so
  // we still extract the data even on a partially captcha'd page.
  const hasNextData = await page
    .evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return false;
      try {
        const parsed = JSON.parse(el.textContent || '');
        return Boolean(parsed && typeof parsed === 'object');
      } catch (_e) {
        return false;
      }
    })
    .catch(() => false);

  if (!hasNextData) {
    if (await detectCaptcha(page)) {
      throw new Error('detail page returned captcha/anti-bot block');
    }
    if (await detectErrorPage(page)) {
      throw new Error('detail page returned error/empty page');
    }
  }

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

    const titleHeading = textOf('h1');
    const secondaryHeading = textOf('h2');
    const subTitle =
      textOf('[class*="property-type"]') ||
      textOf('[data-testid*="property-type"]') ||
      '';
    const allText =
      document.body && (document.body.innerText || document.body.textContent)
        ? document.body.innerText
        : '';

    // Yad2 is a Next.js app and embeds the full listing data in
    // __NEXT_DATA__. When the page renders normally, this script
    // tag carries the city / address / price / rooms / propertyType
    // - much more reliable than reading h1/h2 (which can be the
    // captcha title or a sponsored agency name on some layouts).
    function readNextData() {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      const txt = el.textContent || '';
      try {
        return JSON.parse(txt);
      } catch (_e) {
        return null;
      }
    }

    function deepFindFirst(obj, predicate, depth = 0) {
      if (!obj || typeof obj !== 'object' || depth > 8) return null;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = deepFindFirst(item, predicate, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (predicate(obj)) return obj;
      for (const key of Object.keys(obj)) {
        const found = deepFindFirst(obj[key], predicate, depth + 1);
        if (found) return found;
      }
      return null;
    }

    function extractFromNextData() {
      const data = readNextData();
      if (!data) return null;
      // Yad2's listing data lives somewhere under
      // pageProps -> dehydratedState -> queries[*].state.data
      // The exact shape varies; just walk and look for objects
      // with a recognisable address structure.
      const addressEntry = deepFindFirst(data, (o) => {
        if (!o || typeof o !== 'object') return false;
        // Newer SSR shape: { address: { city: { text }, ... } }
        if (o.address && typeof o.address === 'object') {
          const a = o.address;
          if (a.city && (a.city.text || typeof a.city === 'string')) return true;
          if (a.neighborhood || a.street || a.house) return true;
        }
        return false;
      });
      const itemEntry = deepFindFirst(data, (o) => {
        if (!o || typeof o !== 'object') return false;
        return (
          (typeof o.token === 'string' || typeof o.orderId === 'string') &&
          (o.address || o.price || o.additionalDetails)
        );
      });
      const root = itemEntry || addressEntry || null;
      if (!root) return null;

      // Helpers to safely pull fields with multiple possible shapes.
      const pickText = (v) => {
        if (v == null) return null;
        if (typeof v === 'string') return v.trim() || null;
        if (typeof v === 'object') {
          if (typeof v.text === 'string') return v.text.trim() || null;
          if (typeof v.name === 'string') return v.name.trim() || null;
          if (typeof v.title === 'string') return v.title.trim() || null;
        }
        return null;
      };

      const addr = root.address || (addressEntry && addressEntry.address) || {};
      const city = pickText(addr.city);
      const street = pickText(addr.street);
      const houseNumber =
        addr.house && (addr.house.number ?? addr.house.text ?? null);
      const neighborhood = pickText(addr.neighborhood);
      const area = pickText(addr.area);

      const additional =
        root.additionalDetails || (itemEntry && itemEntry.additionalDetails) || {};
      const propertyType =
        pickText(additional.propertyCondition && additional.propertyCondition.text) ||
        pickText(root.realestateType) ||
        pickText(root.propertyType) ||
        pickText(additional.property);
      const rooms =
        typeof additional.roomsCount === 'number'
          ? additional.roomsCount
          : typeof root.roomsCount === 'number'
            ? root.roomsCount
            : null;

      const price =
        typeof root.price === 'number'
          ? root.price
          : typeof root.metaData?.price === 'number'
            ? root.metaData.price
            : null;

      return {
        city,
        street,
        houseNumber,
        neighborhood,
        area,
        propertyType,
        rooms,
        price
      };
    }

    const nextDataExtracted = extractFromNextData();

    return {
      nextDataExtracted,
      titleHeading,
      secondaryHeading,
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
  const textPrice = Number.isFinite(priceNumeric) ? priceNumeric : null;

  const noPriceHint = /לא צוין מחיר/.test(cleanText);

  const roomsMatch = cleanText.match(/(\d+(?:\.\d+)?)\s*חדרים/);
  const textRooms = roomsMatch ? Number.parseFloat(roomsMatch[1]) : null;

  const headingPropertyType = data.subTitle || guessPropertyType(cleanText);
  const headingCity = extractCityFromHeadings(data);
  const descriptionText = String(data.descriptionText || '').replace(/[\u200e\u200f]/g, '');
  const addressText = String(data.addressText || '').replace(/[\u200e\u200f]/g, '');
  const publishedText = String(data.publishedText || '').replace(/[\u200e\u200f]/g, '');
  const publishedAt = parsePublishedDate(publishedText) || parsePublishedDate(cleanText);
  const floor = parseFloor(cleanText);

  // Yad2's __NEXT_DATA__ blob is the most reliable source - it
  // carries the structured listing fields independent of how the
  // visible DOM renders. Prefer it whenever available; fall back to
  // the heading / body-text heuristics for the bits it doesn't carry.
  const nx = data.nextDataExtracted || {};
  const nxCityRaw = typeof nx.city === 'string' ? nx.city.trim() : '';
  const nxCity = nxCityRaw && !isYad2ErrorText(nxCityRaw) ? nxCityRaw : null;
  const nxPropertyType =
    typeof nx.propertyType === 'string' && nx.propertyType.trim()
      ? nx.propertyType.trim()
      : null;
  const nxPrice = typeof nx.price === 'number' && Number.isFinite(nx.price) ? nx.price : null;
  const nxRooms = typeof nx.rooms === 'number' && Number.isFinite(nx.rooms) ? nx.rooms : null;

  const city = nxCity || headingCity;
  const propertyType = nxPropertyType || headingPropertyType;
  const price = nxPrice ?? textPrice;
  const rooms = nxRooms ?? textRooms;

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
    hasExplicitPrice: !noPriceHint && price !== null,
    floor
  };
}

function parseFloor(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/[\u200e\u200f]/g, '');

  if (/קומ(?:ת|ה)\s*קרקע/.test(cleaned)) return 0;
  if (/\bקומה\s*[:\-]?\s*קרקע\b/.test(cleaned)) return 0;

  const numericMatch = cleaned.match(/קומה\s*[:\-]?\s*(-?\d{1,2})\b/);
  if (numericMatch) {
    const value = Number.parseInt(numericMatch[1], 10);
    if (Number.isFinite(value) && value >= -3 && value <= 50) {
      return value;
    }
  }

  return null;
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

// Anything that looks like Yad2's generic error widget, anti-bot
// challenge page (Radware/ShieldSquare with "Are you for real?" title)
// or a price-area placeholder ("לא צוין מחיר") MUST NOT be stored as
// a real city / title. Used everywhere we derive those fields.
function isYad2ErrorText(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Hebrew error widget.
  if (/אופס\.{2,3}\s*תקלה/.test(trimmed)) return true;
  // Anti-bot / captcha challenge wording.
  if (/are\s+you\s+for\s+real/i.test(trimmed)) return true;
  if (/^\??\s*are\s+you\s+for\s+real\s*\??$/i.test(trimmed)) return true;
  if (/shieldsquare|radware|bot\s*manager\s*block|captcha\s*digest|incident\s*id/i.test(trimmed)) {
    return true;
  }
  if (/אבטחת\s*אתר|מסיבות\s*אבטחה/i.test(trimmed)) return true;
  // Yad2's "no price" placeholder leaking from the price area.
  if (/^\s*לא\s+צוין\s+מחיר\s*$/.test(trimmed)) return true;
  return false;
}

function safeCity(value) {
  if (!value || typeof value !== 'string') return null;
  if (isYad2ErrorText(value)) return null;
  return value;
}

function buildListingTitle({ propertyType, city }) {
  const safe = safeCity(city);
  const parts = [propertyType, safe].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'מודעה';
}

// A "city-shaped" string is non-empty Hebrew/Arabic/Latin text that
// does not look like a street address (no leading digit, no trailing
// number) and is not an agency/realtor name.
function looksLikeCity(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isYad2ErrorText(trimmed)) return false;
  // Street-address shapes:
  //   "הרקפת 162", "383 1", "נחל איילון 20", "שדרות אילות 1"
  // Reject anything containing standalone digits.
  if (/\d/.test(trimmed)) return false;
  // Reject obvious agency / realtor wording that sometimes ends up in
  // h1/h2 on sponsored listings.
  if (/נדל[״"']?ן/i.test(trimmed)) return false;
  if (/RE\/?MAX|UNISTATE|REAL\s+ESTATE|REALTY/i.test(trimmed)) return false;
  if (/תיווך|נכסים|יזמות|שיווק נדל|קפיטל/.test(trimmed)) return false;
  // Pure Latin all-caps brands ("UNISTATE", "S+ REAL ESTATE").
  if (/^[A-Z][A-Z0-9 +\-/]{2,}$/.test(trimmed)) return false;
  // Reasonable length cap to avoid full descriptions.
  if (trimmed.length > 40) return false;
  return true;
}

function extractCityFromHeadings(data) {
  // Prefer the breadcrumb-style secondary heading: "מחוז | עיר | שכונה"
  // or "עיר, עיר". The last part is usually the city. We try every
  // segment from the end backward and pick the first one that looks
  // like a real city (no street numbers, no agency wording).
  const secondary = String(data.secondaryHeading || '').trim();
  if (secondary && !isYad2ErrorText(secondary)) {
    const parts = secondary
      .split(/[,،|/]/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (looksLikeCity(parts[i])) return parts[i];
    }
  }
  // Fallback: the listing's main heading. Only accept it if it
  // actually looks like a city - the heading is often a street
  // address ("הרקפת 162") or an agency name on sponsored listings,
  // both of which we MUST NOT persist as the city.
  const heading = String(data.titleHeading || '').trim();
  if (heading && !isYad2ErrorText(heading)) {
    const firstLine = heading.split('\n')[0].trim();
    if (looksLikeCity(firstLine)) return firstLine;
  }
  return null;
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

async function scrapeOneSearchWithFreshBrowser({
  search,
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

  try {
    const page = await context.newPage();
    await warmUpSession(page, timeoutMs, logger);
    if (extraWarmupMs > 0) {
      await page.waitForTimeout(extraWarmupMs + Math.floor(Math.random() * 2000));
    }

    logger.info(`Checking ${search.label}: ${search.url}`);
    let result = await scrapeSearch(page, search, timeoutMs, { logger });
    if (result.ads.length === 0) {
      logger.warn?.(
        `  ${search.id}: empty result on first attempt; warming up and retrying once in same browser`
      );
      await warmUpSession(page, timeoutMs, logger);
      await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
      result = await scrapeSearch(page, search, timeoutMs, { logger });
    }
    logger.info(`  ${search.id} total: ${result.ads.length}`);
    return { ads: result.ads, error: null };
  } catch (error) {
    logger.error(`Failed scraping ${search.id}: ${error.message}`);
    return { ads: [], error: { searchId: search.id, searchLabel: search.label, message: error.message } };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function scrapeAllSearches({ searches, headless = true, timeoutMs = 60000, logger = console }) {
  const allAds = [];
  const allErrors = [];
  const stillEmpty = [];

  for (let i = 0; i < searches.length; i += 1) {
    const search = searches[i];
    if (i > 0) {
      const gapMs = 3000 + Math.floor(Math.random() * 4000);
      logger.info?.(`  inter-district pause ${gapMs}ms before ${search.id}`);
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }

    const { ads, error } = await scrapeOneSearchWithFreshBrowser({
      search,
      headless,
      timeoutMs,
      logger,
      profile: BROWSER_PROFILES[0]
    });

    if (error) {
      allErrors.push(error);
    }

    if (ads.length > 0) {
      allAds.push(...ads);
    } else {
      stillEmpty.push(search);
    }
  }

  let profileIndex = 1;
  while (stillEmpty.length > 0 && profileIndex < BROWSER_PROFILES.length) {
    const profile = BROWSER_PROFILES[profileIndex];
    const queue = stillEmpty.splice(0);
    logger.warn?.(
      `Retrying ${queue.length} blocked/empty searches (${queue
        .map((s) => s.id)
        .join(', ')}) with fresh browser profile #${profileIndex + 1}`
    );

    for (const search of queue) {
      const gapMs = 5000 + Math.floor(Math.random() * 4000);
      await new Promise((resolve) => setTimeout(resolve, gapMs));

      const { ads, error } = await scrapeOneSearchWithFreshBrowser({
        search,
        headless,
        timeoutMs,
        logger,
        profile,
        extraWarmupMs: 5000
      });

      if (error) {
        allErrors.push(error);
      }

      if (ads.length > 0) {
        allAds.push(...ads);
      } else {
        stillEmpty.push(search);
      }
    }
    profileIndex += 1;
  }

  for (const search of stillEmpty) {
    logger.error(
      `  ${search.id}: still blocked after ${profileIndex} fresh-browser retries; giving up for this run`
    );
    allErrors.push({
      searchId: search.id,
      searchLabel: search.label,
      message: 'blocked by anti-bot after all retries'
    });
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
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none'
    }
  });

  // Warm the session by visiting Yad2's homepage first. Without this
  // step Yad2 returns its Radware/ShieldSquare anti-bot challenge
  // ("Are you for real?") for every direct detail-page GET, which
  // poisons the heal step.
  try {
    const warmupPage = await context.newPage();
    await warmupPage.goto('https://www.yad2.co.il/', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });
    await warmupPage.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
    await warmupPage.close();
  } catch (warmupError) {
    logger.warn?.(`Enrichment warmup failed (continuing anyway): ${warmupError.message}`);
  }

  const pages = await Promise.all(
    Array.from({ length: Math.min(concurrency, ads.length) }, () => context.newPage())
  );

  const queue = ads.slice();
  const enriched = [];
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;

  async function reWarmupOn(page) {
    try {
      await page.goto('https://www.yad2.co.il/', {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      });
      await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
    } catch (warmupError) {
      logger.warn?.(`  retry warmup failed: ${warmupError.message}`);
    }
  }

  async function fetchWithRetry(page, ad) {
    const maxAttempts = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fetchListingDetails(page, ad.link, timeoutMs);
      } catch (error) {
        lastError = error;
        const isCaptcha = /captcha|anti-bot|are you for real/i.test(error.message || '');
        if (attempt < maxAttempts) {
          logger.warn?.(
            `  detail fetch attempt ${attempt}/${maxAttempts} failed for ${ad.link}: ${error.message}${
              isCaptcha ? ' - re-warming session' : ''
            }`
          );
          if (isCaptcha) {
            await reWarmupOn(page);
          } else {
            await page.waitForTimeout(1200 + Math.floor(Math.random() * 800));
          }
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
          floor: details.floor ?? null,
          enriched: true
        });
      } catch (error) {
        logger.error(`Failed fetching details for ${ad.link}: ${error.message}`);
        enriched.push({ ...ad, hasExplicitPrice: false, enriched: false });
      }
      // Small humanised pause between detail-page requests on the
      // same Playwright page. Yad2's anti-bot is more permissive on
      // sessions that don't fire requests back-to-back. Without this
      // delay the second / third request after warmup tends to hit
      // the captcha challenge again.
      await page.waitForTimeout(800 + Math.floor(Math.random() * 1200));
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

// Public-facing probe used by the health check to classify each ad URL.
// Returns one of: 'live' | 'removed' | 'blocked' | 'error' along with a
// human-readable reason. Never throws on its own — callers can rely on
// the status field instead of try/catch.
async function probeListingsPresence({
  urls,
  headless = true,
  timeoutMs = 12000,
  concurrency = 4,
  logger = console
} = {}) {
  if (!Array.isArray(urls) || !urls.length) return [];

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
    Array.from({ length: Math.min(concurrency, urls.length) }, () => context.newPage())
  );

  const queue = urls.slice();
  const results = [];

  async function classify(page, url) {
    let response = null;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      });
    } catch (error) {
      return { url, status: 'error', reason: error.message || 'goto failed' };
    }

    const httpStatus = response ? response.status() : null;
    if (httpStatus === 404 || httpStatus === 410) {
      return { url, status: 'removed', reason: `HTTP ${httpStatus}`, httpStatus };
    }
    if (httpStatus && httpStatus >= 500) {
      return { url, status: 'error', reason: `HTTP ${httpStatus}`, httpStatus };
    }

    try {
      if (await detectCaptcha(page)) {
        return { url, status: 'blocked', reason: 'captcha/anti-bot', httpStatus };
      }
    } catch {
      // detectCaptcha can fail on torn-down pages; treat as error.
      return { url, status: 'error', reason: 'captcha probe failed', httpStatus };
    }

    let pageSignals;
    try {
      pageSignals = await page.evaluate(() => {
        const title = ((document.title || '') + '').toLowerCase();
        const bodyText = ((document.body && document.body.innerText) || '').trim();
        return { title, bodyText };
      });
    } catch (error) {
      return { url, status: 'error', reason: error.message || 'evaluate failed', httpStatus };
    }

    const { title, bodyText } = pageSignals;

    // Strong "ad was removed" signals from Yad2's own UX.
    const removedPatterns = [
      /המודעה (הוסרה|אינה זמינה|לא קיימת|נמחקה)/,
      /מודעה (זו|הזו) (הוסרה|אינה|לא קיימת)/,
      /המודעה כבר אינה פעילה/,
      /the listing (was removed|is no longer available)/i
    ];
    if (removedPatterns.some((re) => re.test(bodyText))) {
      return {
        url,
        status: 'removed',
        reason: 'Yad2 says the listing was removed',
        httpStatus
      };
    }

    const notFoundPatterns = [/^404/, /^page not found/, /^not found/];
    if (notFoundPatterns.some((re) => re.test(title))) {
      return { url, status: 'removed', reason: `title=${title}`, httpStatus };
    }

    if (/אופס\.\.\.\s*תקלה|אופס\.{2,3}\s*תקלה/.test(bodyText)) {
      // Generic Yad2 "oops, something went wrong" — could be transient,
      // not a confirmed removal.
      return { url, status: 'error', reason: 'Yad2 generic error page', httpStatus };
    }

    if (bodyText.length < 200) {
      // Empty / shell page that did not 404 → ambiguous; do not delete.
      return { url, status: 'error', reason: 'page body too short', httpStatus };
    }

    return { url, status: 'live', reason: null, httpStatus };
  }

  async function worker(page) {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      try {
        const result = await classify(page, url);
        results.push(result);
      } catch (error) {
        logger.error?.(`[probe] unexpected failure for ${url}: ${error.message}`);
        results.push({ url, status: 'error', reason: error.message || 'unknown' });
      }
    }
  }

  try {
    await Promise.all(pages.map((page) => worker(page)));
  } finally {
    await context.close();
    await browser.close();
  }

  return results;
}

module.exports = {
  enrichAdsWithDetails,
  extractCityFromHeadings,
  extractExternalId,
  extractTitle,
  fetchListingDetails,
  isYad2ErrorText,
  looksLikeCity,
  normalizeItemUrl,
  parseCityFromTitle,
  parseFloor,
  parsePublishedDate,
  probeListingsPresence,
  scrapeAllSearches
};
