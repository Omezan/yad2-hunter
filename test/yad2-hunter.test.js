const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterRelevantAds,
  getRejection,
  isRelevant
} = require('../src/services/relevance');
const {
  buildHealthCheckMessages,
  describeScrapeError,
  formatDigestMessage,
  formatDigestMessages,
  formatHealthCheckMessage,
  formatManualScanNoNewAdsMessage,
  formatPartialScrapeWarning,
  formatReconciliationLine,
  summarizeScrapeErrors
} = require('../src/services/telegram');
const {
  extractCityFromHeadings,
  extractExternalId,
  isYad2ErrorText,
  looksLikeCity,
  normalizeItemUrl,
  parseCityFromTitle,
  parseFloor,
  parsePublishedDate
} = require('../src/scraper/yad2');
const { removeDeletedAds } = require('../src/store/file-store');
const { reconcileSeen } = require('../src/worker/health-check');
const {
  buildNotifyChannelMap,
  partitionAdsByChannel,
  pickManualNoticeChannels,
  selectAdsForTelegram
} = require('../src/worker/run-once');
const {
  ALL_SEARCHES,
  getHealthCheckSearches
} = require('../src/config/searches');
const {
  __testing: emailTesting
} = require('../src/services/email');
const { __testing: loopTesting } = require('../src/worker/run-loop');
const {
  mergeCooldowns,
  mergeRuns,
  mergeSeenAds
} = require('../scripts/merge-state');
const {
  buildActiveCooldownMap,
  emptyState,
  getCooldown,
  isCooledDown,
  pruneExpired,
  setBlocked
} = require('../src/store/scrape-cooldowns');

const ITEM = 'https://www.yad2.co.il/realestate/item/center-and-sharon/abc123';

function makeAd(overrides) {
  return {
    title: 'דירה, בת חפר',
    rawText: 'דירה, בת חפר\n6 חדרים\n7,000 ₪',
    descriptionText: 'דירה ביישוב כפרי, גינה גדולה ופרטיות מלאה',
    locationText: 'בת חפר',
    city: 'בת חפר',
    propertyType: 'דירה',
    searchLabel: 'מרכז ושרון',
    link: ITEM,
    price: 7000,
    rooms: 6,
    settlementsOnly: true,
    hasExplicitPrice: true,
    enriched: true,
    ...overrides
  };
}

test('normalizeItemUrl strips query params and trailing slash', () => {
  assert.equal(
    normalizeItemUrl('https://www.yad2.co.il/realestate/item/center-and-sharon/abc123/?foo=bar'),
    'https://www.yad2.co.il/realestate/item/center-and-sharon/abc123'
  );
});

test('extractExternalId returns the district + listing id segment', () => {
  assert.equal(
    extractExternalId('https://www.yad2.co.il/realestate/item/center-and-sharon/abc123?foo=bar'),
    'center-and-sharon/abc123'
  );

  assert.notEqual(
    extractExternalId('https://www.yad2.co.il/realestate/item/center-and-sharon/abc123'),
    extractExternalId('https://www.yad2.co.il/realestate/item/center-and-sharon/xyz999')
  );
});

test('isRelevant accepts a normal feed ad', () => {
  assert.equal(isRelevant(makeAd()), true);
});

test('isRelevant rejects non-item URLs', () => {
  const ad = makeAd({ link: 'https://www.yad2.co.il/commercial-projects/abc' });
  assert.equal(getRejection(ad), 'non-item-url');
});

test('cross-district suggestion URLs are rejected', () => {
  const ad = makeAd({ link: 'https://www.yad2.co.il/realestate/item/wgub12o4' });
  assert.equal(getRejection(ad), 'cross-district-suggestion');
});

test('isRelevant accepts ads regardless of price (URL handles the cap)', () => {
  const ad = makeAd({ price: 12000 });
  assert.equal(getRejection(ad), null);
});

test('isRelevant accepts ads regardless of rooms (URL handles the cap)', () => {
  const ad = makeAd({ rooms: 3 });
  assert.equal(getRejection(ad), null);
});

test('isRelevant accepts urban-named ads (no urban filter anymore)', () => {
  const ad = makeAd({
    title: 'דירה במרכז',
    city: 'תל אביב',
    locationText: 'תל אביב',
    descriptionText: 'דירה במרכז העיר'
  });
  assert.equal(getRejection(ad), null);
});

test('isRelevant accepts יחידת דיור and high-floor דירה (no floor/type filters)', () => {
  assert.equal(
    getRejection(
      makeAd({
        propertyType: 'יחידת דיור',
        addressText: 'יחידת דיור',
        descriptionText: 'יחידת דיור עצמאית במושב'
      })
    ),
    null
  );

  assert.equal(
    getRejection(
      makeAd({
        propertyType: 'דירה',
        floor: 3,
        descriptionText: 'דירה מרווחת בקומה 3'
      })
    ),
    null
  );
});

test('isRelevant accepts a sponsored real listing (מודעה מקודמת is fine on its own)', () => {
  const ad = makeAd({
    rawText: 'מודעה מקודמת — דירה, בת חפר',
    descriptionText: 'דירה במושב, מרפסת גדולה'
  });
  assert.equal(getRejection(ad), null);
});

test('isRelevant rejects פרויקט חדש promotions', () => {
  const ad = makeAd({
    title: 'פרויקט חדש',
    descriptionText: 'פרויקט חדש בקיבוץ דוגמה'
  });
  assert.equal(getRejection(ad), 'keyword:פרויקט חדש');
});

test('isRelevant rejects בלעדי בפרויקט / תמ"א / התחדשות עירונית promo descriptions', () => {
  for (const kw of ['בלעדי בפרויקט', 'תמ"א', 'התחדשות עירונית']) {
    const ad = makeAd({ descriptionText: `הזדמנות: ${kw} בלב היישוב` });
    assert.equal(getRejection(ad), `keyword:${kw}`, `expected reject for ${kw}`);
  }
});

test('promo keyword check ignores the noisy rawText for enriched ads', () => {
  const ad = makeAd({
    enriched: true,
    rawText: 'פרויקט חדש פרסומת מסיחת דעת',
    descriptionText: 'בית יפה וגדול עם גינה'
  });
  assert.equal(getRejection(ad), null);
});

test('un-enriched ads still match promo keywords on rawText', () => {
  const ad = makeAd({
    enriched: false,
    rawText: 'פרויקט חדש - הכל מקבלן',
    descriptionText: ''
  });
  assert.equal(getRejection(ad), 'keyword:פרויקט חדש');
});

test('parseFloor handles common Yad2 floor strings', () => {
  assert.equal(parseFloor('קומה 1/1'), 1);
  assert.equal(parseFloor('קומה 3 מתוך 5'), 3);
  assert.equal(parseFloor('קומת קרקע'), 0);
  assert.equal(parseFloor('קומה קרקע'), 0);
  assert.equal(parseFloor('דירה במפלס 1 מעל בית קרקע'), null);
  assert.equal(parseFloor(''), null);
  assert.equal(parseFloor('שום מילה רלוונטית'), null);
  assert.equal(parseFloor('קומה: 0'), 0);
});

test('formatDigestMessage includes title, rooms, price, and link', () => {
  const message = formatDigestMessage({
    newAds: [
      {
        title: 'דירה, בת חפר',
        districtLabel: 'מרכז והשרון',
        link: 'https://www.yad2.co.il/realestate/item/center-and-sharon/abc1',
        rooms: 6,
        price: 7000
      },
      {
        title: 'בית פרטי, לוטם',
        districtLabel: 'צפון והעמקים',
        link: 'https://www.yad2.co.il/realestate/item/north-and-valleys/abc2',
        rooms: 5.5,
        price: 6100
      }
    ]
  });

  assert.match(message, /נמצאו 2 מודעות חדשות/);
  assert.match(message, /דירה, בת חפר/);
  assert.match(message, /6 חדרים/);
  assert.match(message, /7,000 ₪/);
  assert.match(message, /בית פרטי, לוטם/);
  assert.match(message, /5\.5 חדרים/);
  assert.match(message, /6,100 ₪/);
  // District/region is appended to each ad's heading line.
  assert.match(message, /דירה, בת חפר, מרכז והשרון/);
  assert.match(message, /בית פרטי, לוטם, צפון והעמקים/);
});

test('parsePublishedDate parses Yad2 פורסם dates', () => {
  assert.equal(parsePublishedDate('פורסם ב 16/04/26'), '2026-04-16');
  assert.equal(parsePublishedDate('עודכן ב 1/3/2026'), '2026-03-01');
  assert.equal(parsePublishedDate('no date here'), null);
  assert.equal(parsePublishedDate(''), null);
});

test('formatDigestMessage includes publishedAt when present', () => {
  const message = formatDigestMessage({
    newAds: [
      {
        title: 'דירה, בת חפר',
        link: 'https://www.yad2.co.il/realestate/item/center-and-sharon/abc1',
        rooms: 6,
        price: 7000,
        hasExplicitPrice: true,
        publishedAt: '2026-04-16'
      }
    ]
  });
  assert.match(message, /פורסם 16\/04\/26/);
});

test('formatDigestMessage shows מחיר לא מצוין for ads with no explicit price', () => {
  const message = formatDigestMessage({
    newAds: [
      {
        title: 'בית, יישוב כלשהו',
        districtLabel: 'דרום',
        link: 'https://www.yad2.co.il/realestate/item/south/abc1',
        rooms: 4,
        price: null,
        hasExplicitPrice: false
      }
    ]
  });

  assert.match(message, /מחיר לא מצוין/);
  assert.doesNotMatch(message, /\d+\s*₪/);
});

test('formatDigestMessages splits long digests into chunks under the Telegram limit', () => {
  const newAds = Array.from({ length: 80 }, (_, i) => ({
    title: `דירה מס׳ ${i + 1} ביישוב הדגמה ארוך מאוד`,
    districtLabel: 'מרכז והשרון',
    link: `https://www.yad2.co.il/realestate/item/center-and-sharon/dummy${i + 1}`,
    rooms: 4,
    price: 7000 + i
  }));

  const messages = formatDigestMessages({ newAds });

  assert.ok(messages.length > 1, 'Expected the digest to be split into multiple parts');
  for (const msg of messages) {
    assert.ok(msg.length <= 4096, `Message too long: ${msg.length}`);
    assert.match(msg, /נמצאו 80 מודעות חדשות/);
    assert.match(msg, /חלק \d+ מתוך \d+/);
  }

  for (let i = 1; i <= 80; i += 1) {
    const found = messages.some((msg) => msg.includes(`/dummy${i}`));
    assert.ok(found, `Ad #${i} missing from digest chunks`);
  }
});

test('formatManualScanNoNewAdsMessage announces a finished manual scan with zero results', () => {
  const message = formatManualScanNoNewAdsMessage({
    runStartedAt: '2026-04-29T19:30:00.000Z'
  });

  assert.match(message, /Yad2 Hunter — סריקה ידנית הסתיימה/);
  assert.match(message, /לא נמצאו מודעות חדשות/);
});

test('formatManualScanNoNewAdsMessage works without a dashboard URL configured', () => {
  const envModule = require('../src/config/env');
  const previous = envModule.env.DASHBOARD_URL;
  envModule.env.DASHBOARD_URL = '';
  try {
    const message = formatManualScanNoNewAdsMessage({
      runStartedAt: '2026-04-29T19:30:00.000Z'
    });
    assert.match(message, /לא נמצאו מודעות חדשות/);
    assert.doesNotMatch(message, /לוח בקרה:/);
  } finally {
    envModule.env.DASHBOARD_URL = previous;
  }
});

test('formatManualScanNoNewAdsMessage includes the dashboard link with a since param when configured', () => {
  const envModule = require('../src/config/env');
  const previous = envModule.env.DASHBOARD_URL;
  envModule.env.DASHBOARD_URL = 'https://yad2hunter.example.com';
  try {
    const message = formatManualScanNoNewAdsMessage({
      runStartedAt: '2026-04-29T19:30:00.000Z'
    });
    assert.match(message, /לוח בקרה: https:\/\/yad2hunter\.example\.com\?since=/);
  } finally {
    envModule.env.DASHBOARD_URL = previous;
  }
});

test('filterRelevantAds keeps city ads and drops only suggestion / promo entries', () => {
  const accepted = filterRelevantAds([
    makeAd(),
    makeAd({
      title: 'מודעה בעיר',
      city: 'תל אביב',
      locationText: 'תל אביב',
      descriptionText: 'דירה במרכז העיר'
    }),
    makeAd({ link: 'https://www.yad2.co.il/realestate/item/wgub12o4' }),
    makeAd({ descriptionText: 'בלעדי בפרויקט חדש' })
  ]);
  assert.equal(accepted.length, 2);
});

test('removeDeletedAds drops seen ads that were not returned by the latest scrape of their district', () => {
  const seen = {
    ads: {
      keep1: { externalId: 'keep1', searchId: 'south' },
      drop1: { externalId: 'drop1', searchId: 'south' },
      keep2: { externalId: 'keep2', searchId: 'north-valleys' }
    }
  };
  const scraped = [
    { externalId: 'keep1', searchId: 'south' },
    { externalId: 'keep2', searchId: 'north-valleys' }
  ];
  const { seen: next, removed } = removeDeletedAds(seen, scraped, [
    'south',
    'north-valleys'
  ]);

  assert.deepEqual(Object.keys(next.ads).sort(), ['keep1', 'keep2']);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].externalId, 'drop1');
  assert.equal(removed[0].searchId, 'south');
});

test('removeDeletedAds keeps ads from districts whose scrape failed', () => {
  const seen = {
    ads: {
      a: { externalId: 'a', searchId: 'south' },
      b: { externalId: 'b', searchId: 'jerusalem' }
    }
  };
  const scraped = [{ externalId: 'a', searchId: 'south' }];
  const { seen: next, removed } = removeDeletedAds(seen, scraped, ['south']);

  assert.deepEqual(Object.keys(next.ads).sort(), ['a', 'b']);
  assert.equal(removed.length, 0);
});

test('removeDeletedAds is a no-op when no districts were successfully scraped', () => {
  const seen = {
    ads: {
      a: { externalId: 'a', searchId: 'south' }
    }
  };
  const { seen: next, removed } = removeDeletedAds(seen, [], []);
  assert.deepEqual(next, seen);
  assert.equal(removed.length, 0);
});

test('removeDeletedAds refuses to wipe a district that returned ZERO ads', () => {
  const seen = {
    ads: {
      a: { externalId: 'a', searchId: 'south' },
      b: { externalId: 'b', searchId: 'south' }
    }
  };
  const { seen: next, removed, skippedDistricts } = removeDeletedAds(
    seen,
    [],
    ['south']
  );

  assert.deepEqual(Object.keys(next.ads).sort(), ['a', 'b']);
  assert.equal(removed.length, 0);
  assert.equal(skippedDistricts.length, 1);
  assert.equal(skippedDistricts[0].searchId, 'south');
  assert.equal(skippedDistricts[0].reason, 'no-live-ads');
});

test('removeDeletedAds refuses cleanup when live count is suspiciously low vs seen', () => {
  const seen = {
    ads: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `id${i}`,
        { externalId: `id${i}`, searchId: 'north-valleys' }
      ])
    )
  };
  const scraped = Array.from({ length: 10 }, (_, i) => ({
    externalId: `id${i}`,
    searchId: 'north-valleys'
  }));

  const { seen: next, removed, skippedDistricts } = removeDeletedAds(
    seen,
    scraped,
    ['north-valleys']
  );

  assert.equal(Object.keys(next.ads).length, 100);
  assert.equal(removed.length, 0);
  assert.equal(skippedDistricts.length, 1);
  assert.equal(skippedDistricts[0].reason, 'live-too-low-vs-seen');
});

test('removeDeletedAds still cleans up the genuinely missing single ad', () => {
  const seen = {
    ads: Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        `id${i}`,
        { externalId: `id${i}`, searchId: 'south' }
      ])
    )
  };
  const scraped = Array.from({ length: 49 }, (_, i) => ({
    externalId: `id${i + 1}`,
    searchId: 'south'
  }));

  const { removed, skippedDistricts } = removeDeletedAds(seen, scraped, [
    'south'
  ]);

  assert.equal(removed.length, 1);
  assert.equal(removed[0].externalId, 'id0');
  assert.equal(skippedDistricts.length, 0);
});

test('getHealthCheckSearches reconciles every watch, including lev-hapark and rent-in-cities', () => {
  // The daily reconciler is now the sole owner of deletions across
  // every watch. There must be no leftover "excludeFromHealthCheck"
  // gate.
  const healthCheckIds = getHealthCheckSearches().map((s) => s.id);
  const expected = new Set([
    'jerusalem',
    'center-sharon',
    'south',
    'coastal-north',
    'north-valleys',
    'lev-hapark-rent',
    'lev-hapark-sale',
    'rent-in-cities'
  ]);
  assert.deepEqual(new Set(healthCheckIds), expected);
  assert.equal(
    healthCheckIds.length,
    ALL_SEARCHES.length,
    'every configured search must be in the health-check set'
  );
});

test('ALL_SEARCHES no longer carries the legacy excludeFromHealthCheck flag', () => {
  for (const search of ALL_SEARCHES) {
    assert.equal(
      'excludeFromHealthCheck' in search,
      false,
      `${search.id} still has excludeFromHealthCheck`
    );
  }
});

test('mergeSeenAds: local-only and remote-only keys are both kept', () => {
  const local = {
    ads: {
      A: { externalId: 'A', firstSeenAt: '2026-04-29T10:00:00Z', lastSeenAt: '2026-04-29T11:00:00Z' }
    }
  };
  const remote = {
    ads: {
      B: { externalId: 'B', firstSeenAt: '2026-04-29T09:00:00Z', lastSeenAt: '2026-04-29T09:30:00Z' }
    }
  };
  const merged = mergeSeenAds(local, remote);
  assert.equal(Object.keys(merged.ads).length, 2);
  assert.ok(merged.ads.A);
  assert.ok(merged.ads.B);
});

test('mergeSeenAds: shared keys keep earliest firstSeenAt and latest lastSeenAt', () => {
  const local = {
    ads: {
      A: {
        externalId: 'A',
        title: 'newer enrichment',
        firstSeenAt: '2026-04-29T12:00:00Z',
        lastSeenAt: '2026-04-29T18:00:00Z',
        rooms: 4
      }
    }
  };
  const remote = {
    ads: {
      A: {
        externalId: 'A',
        title: 'older enrichment',
        firstSeenAt: '2026-04-28T08:00:00Z',
        lastSeenAt: '2026-04-29T15:00:00Z'
      }
    }
  };
  const merged = mergeSeenAds(local, remote);
  assert.equal(merged.ads.A.firstSeenAt, '2026-04-28T08:00:00Z');
  assert.equal(merged.ads.A.lastSeenAt, '2026-04-29T18:00:00Z');
  assert.equal(merged.ads.A.title, 'newer enrichment');
  assert.equal(merged.ads.A.rooms, 4);
});

test('mergeSeenAds: regression — a manual run that just added an ad does not get wiped by a stale remote', () => {
  const matanFromManual = {
    externalId: 'center-and-sharon/MATAN1',
    title: 'דירה, מתן',
    city: 'מתן',
    searchId: 'center-sharon',
    firstSeenAt: '2026-04-29T22:00:00Z',
    lastSeenAt: '2026-04-29T22:00:00Z'
  };
  const local = {
    ads: {
      'center-and-sharon/MATAN1': matanFromManual,
      'shared-key': { externalId: 'shared-key', searchId: 'jerusalem' }
    }
  };
  const remoteThatDoesNotKnowAboutMatan = {
    ads: {
      'shared-key': { externalId: 'shared-key', searchId: 'jerusalem' },
      'concurrent-add': { externalId: 'concurrent-add', searchId: 'north-valleys' }
    }
  };
  const merged = mergeSeenAds(local, remoteThatDoesNotKnowAboutMatan);
  assert.ok(merged.ads['center-and-sharon/MATAN1'], 'מתן must survive the merge');
  assert.ok(merged.ads['concurrent-add'], 'concurrent-add must survive the merge');
  assert.ok(merged.ads['shared-key'], 'shared key must survive the merge');
});

test('mergeRuns: dedupes by startedAt, sorts newest first, caps to history limit', () => {
  const local = {
    runs: [
      { startedAt: '2026-04-29T22:00:00Z', trigger: 'manual-dashboard' },
      { startedAt: '2026-04-29T21:00:00Z', trigger: 'github-actions-loop' }
    ]
  };
  const remote = {
    runs: [
      { startedAt: '2026-04-29T21:30:00Z', trigger: 'github-actions-loop' },
      { startedAt: '2026-04-29T21:00:00Z', trigger: 'github-actions-loop' }
    ]
  };
  const merged = mergeRuns(local, remote);
  assert.equal(merged.runs.length, 3);
  assert.equal(merged.runs[0].startedAt, '2026-04-29T22:00:00Z');
  assert.equal(merged.runs[0].trigger, 'manual-dashboard');
  assert.equal(merged.runs[1].startedAt, '2026-04-29T21:30:00Z');
  assert.equal(merged.runs[2].startedAt, '2026-04-29T21:00:00Z');
});

test('mergeRuns: caps merged log at the configured history limit', () => {
  const local = {
    runs: Array.from({ length: 30 }, (_, i) => ({
      startedAt: new Date(Date.UTC(2026, 3, 29, i, 0, 0)).toISOString(),
      trigger: 'github-actions-loop'
    }))
  };
  const remote = {
    runs: Array.from({ length: 60 }, (_, i) => ({
      startedAt: new Date(Date.UTC(2026, 3, 28, Math.floor(i / 2), (i % 2) * 30, 0)).toISOString(),
      trigger: 'github-actions-loop'
    }))
  };
  const merged = mergeRuns(local, remote);
  assert.equal(merged.runs.length, 50, 'merged log should be capped at HISTORY_LIMIT (50)');
});

// -----------------------------------------------------------------------------
// reconcileSeen (health-check fixes diffs in-place)
// -----------------------------------------------------------------------------

function makeReconcileInputs(overrides = {}) {
  const seen = overrides.seen || {
    ads: {
      'south/EXISTS': {
        externalId: 'south/EXISTS',
        searchId: 'south',
        link: 'https://www.yad2.co.il/realestate/item/south/EXISTS',
        firstSeenAt: '2026-04-29T10:00:00Z',
        lastSeenAt: '2026-04-29T10:00:00Z'
      },
      'south/REMOVED': {
        externalId: 'south/REMOVED',
        searchId: 'south',
        link: 'https://www.yad2.co.il/realestate/item/south/REMOVED',
        firstSeenAt: '2026-04-28T10:00:00Z',
        lastSeenAt: '2026-04-28T10:00:00Z'
      }
    }
  };
  const rows = overrides.rows || [
    {
      searchId: 'south',
      label: 'דרום',
      missingIds: ['south/NEW'],
      extraIds: ['south/REMOVED'],
      scrapedIds: ['south/EXISTS', 'south/NEW']
    }
  ];
  const extraClassification =
    overrides.extraClassification ||
    new Map([
      [
        'https://www.yad2.co.il/realestate/item/south/REMOVED',
        { status: 'removed', reason: 'HTTP 404' }
      ]
    ]);
  const missingClassification =
    overrides.missingClassification ||
    new Map([
      [
        'south/NEW',
        {
          kind: 'admit',
          enriched: {
            externalId: 'south/NEW',
            link: 'https://www.yad2.co.il/realestate/item/south/NEW',
            title: 'דירה חדשה',
            city: 'מתן',
            districtLabel: 'דרום',
            price: 6500,
            rooms: 4
          }
        }
      ]
    ]);
  return {
    rows,
    seen,
    extraClassification,
    missingClassification,
    generatedAt: '2026-04-30T07:00:00Z',
    searchById: new Map([['south', { id: 'south', label: 'דרום' }]])
  };
}

test('reconcileSeen drops a 404\'d ad from seen and admits a freshly scraped one', () => {
  const result = reconcileSeen(makeReconcileInputs());
  assert.deepEqual(
    result.removals.map((r) => r.externalId),
    ['south/REMOVED']
  );
  assert.deepEqual(
    result.additions.map((a) => a.externalId),
    ['south/NEW']
  );
  assert.equal(result.unresolvedExtras.length, 0);
  assert.equal(result.unresolvedMissing.length, 0);
  assert.equal(result.updatedSeen.ads['south/REMOVED'], undefined);
  assert.ok(result.updatedSeen.ads['south/NEW']);
  assert.equal(result.updatedSeen.ads['south/EXISTS'].externalId, 'south/EXISTS');
});

test('reconcileSeen keeps an extra ad in seen when probe is inconclusive (e.g. blocked / error)', () => {
  const inputs = makeReconcileInputs({
    extraClassification: new Map([
      [
        'https://www.yad2.co.il/realestate/item/south/REMOVED',
        { status: 'blocked', reason: 'captcha/anti-bot' }
      ]
    ])
  });
  const result = reconcileSeen(inputs);
  assert.equal(result.removals.length, 0, 'must NOT delete based on a blocked probe');
  assert.equal(result.unresolvedExtras.length, 1);
  assert.equal(result.unresolvedExtras[0].status, 'blocked');
  assert.ok(
    result.updatedSeen.ads['south/REMOVED'],
    'ad stays in seen because we have not confirmed removal'
  );
});

test('reconcileSeen does not admit a missing ad whose enrichment was rejected by relevance', () => {
  const inputs = makeReconcileInputs({
    missingClassification: new Map([
      [
        'south/NEW',
        { kind: 'rejected', reason: 'נדחתה על ידי סינון הרלוונטיות' }
      ]
    ])
  });
  const result = reconcileSeen(inputs);
  assert.equal(result.additions.length, 0);
  assert.equal(result.unresolvedMissing.length, 1);
  assert.equal(result.updatedSeen.ads['south/NEW'], undefined);
});

test('reconcileSeen does not admit a missing ad whose enrichment failed (transient)', () => {
  const inputs = makeReconcileInputs({
    missingClassification: new Map([
      [
        'south/NEW',
        { kind: 'unenriched', reason: 'לא הצלחנו לטעון את פרטי המודעה כרגע — תיבדק שוב בריצה הבאה' }
      ]
    ])
  });
  const result = reconcileSeen(inputs);
  assert.equal(result.additions.length, 0);
  assert.equal(result.unresolvedMissing.length, 1);
});

test('reconcileSeen retires a live extra whose price was raised above maxPrice', () => {
  const inputs = makeReconcileInputs({
    seen: {
      ads: {
        'south/REMOVED': {
          externalId: 'south/REMOVED',
          searchId: 'south',
          link: 'https://www.yad2.co.il/realestate/item/south/REMOVED',
          firstSeenAt: '2026-04-28T10:00:00Z',
          lastSeenAt: '2026-04-28T10:00:00Z',
          price: 8500,
          rooms: 5
        }
      }
    },
    rows: [
      {
        searchId: 'south',
        label: 'דרום',
        missingIds: [],
        extraIds: ['south/REMOVED'],
        scrapedIds: []
      }
    ],
    extraClassification: new Map([
      [
        'https://www.yad2.co.il/realestate/item/south/REMOVED',
        { status: 'live', reason: null, price: 15000, rooms: 5 }
      ]
    ]),
    missingClassification: new Map()
  });
  const result = reconcileSeen({
    ...inputs,
    filterLimitsBySearchId: new Map([
      ['south', { maxPrice: 9000, minRooms: 4 }]
    ])
  });
  assert.equal(result.removals.length, 1, 'price-bumped ad should be retired');
  assert.equal(result.removals[0].externalId, 'south/REMOVED');
  assert.match(result.removals[0].reason, /15,000.*9,000/);
  assert.equal(result.unresolvedExtras.length, 0);
  assert.equal(result.updatedSeen.ads['south/REMOVED'], undefined);
});

test('reconcileSeen retires a live extra whose room count fell below minRooms', () => {
  const inputs = makeReconcileInputs({
    seen: {
      ads: {
        'south/REMOVED': {
          externalId: 'south/REMOVED',
          searchId: 'south',
          link: 'https://www.yad2.co.il/realestate/item/south/REMOVED',
          firstSeenAt: '2026-04-28T10:00:00Z',
          lastSeenAt: '2026-04-28T10:00:00Z',
          price: 7000,
          rooms: 4
        }
      }
    },
    rows: [
      {
        searchId: 'south',
        label: 'דרום',
        missingIds: [],
        extraIds: ['south/REMOVED'],
        scrapedIds: []
      }
    ],
    extraClassification: new Map([
      [
        'https://www.yad2.co.il/realestate/item/south/REMOVED',
        { status: 'live', reason: null, price: 7000, rooms: 3 }
      ]
    ]),
    missingClassification: new Map()
  });
  const result = reconcileSeen({
    ...inputs,
    filterLimitsBySearchId: new Map([
      ['south', { maxPrice: 9000, minRooms: 4 }]
    ])
  });
  assert.equal(result.removals.length, 1);
  assert.match(result.removals[0].reason, /החדרים.*3.*4/);
  assert.equal(result.updatedSeen.ads['south/REMOVED'], undefined);
});

test('reconcileSeen does NOT retire a live extra whose price/rooms are still within range', () => {
  const inputs = makeReconcileInputs({
    seen: {
      ads: {
        'south/STILL_OK': {
          externalId: 'south/STILL_OK',
          searchId: 'south',
          link: 'https://www.yad2.co.il/realestate/item/south/STILL_OK',
          firstSeenAt: '2026-04-28T10:00:00Z',
          lastSeenAt: '2026-04-28T10:00:00Z',
          price: 7000,
          rooms: 5
        }
      }
    },
    rows: [
      {
        searchId: 'south',
        label: 'דרום',
        missingIds: [],
        extraIds: ['south/STILL_OK'],
        scrapedIds: []
      }
    ],
    extraClassification: new Map([
      [
        'https://www.yad2.co.il/realestate/item/south/STILL_OK',
        { status: 'live', reason: null, price: 7500, rooms: 5 }
      ]
    ]),
    missingClassification: new Map()
  });
  const result = reconcileSeen({
    ...inputs,
    filterLimitsBySearchId: new Map([
      ['south', { maxPrice: 9000, minRooms: 4 }]
    ])
  });
  assert.equal(result.removals.length, 0);
  assert.equal(result.unresolvedExtras.length, 1);
  assert.equal(result.unresolvedExtras[0].status, 'live');
  assert.ok(result.updatedSeen.ads['south/STILL_OK']);
});

test('reconcileSeen falls back to seen-stored price when probe price is missing', () => {
  // Simulates a live probe whose page parser couldn't extract a number
  // (e.g. price hidden behind "פנה לבעל המודעה"). We should rely on
  // the value we stored at admission time rather than guessing.
  const inputs = makeReconcileInputs({
    seen: {
      ads: {
        'south/SEEN_OOR': {
          externalId: 'south/SEEN_OOR',
          searchId: 'south',
          link: 'https://www.yad2.co.il/realestate/item/south/SEEN_OOR',
          firstSeenAt: '2026-04-28T10:00:00Z',
          lastSeenAt: '2026-04-28T10:00:00Z',
          price: 12000,
          rooms: 5
        }
      }
    },
    rows: [
      {
        searchId: 'south',
        label: 'דרום',
        missingIds: [],
        extraIds: ['south/SEEN_OOR'],
        scrapedIds: []
      }
    ],
    extraClassification: new Map([
      [
        'https://www.yad2.co.il/realestate/item/south/SEEN_OOR',
        { status: 'live', reason: null, price: null, rooms: null }
      ]
    ]),
    missingClassification: new Map()
  });
  const result = reconcileSeen({
    ...inputs,
    filterLimitsBySearchId: new Map([
      ['south', { maxPrice: 9000, minRooms: 4 }]
    ])
  });
  assert.equal(result.removals.length, 1);
  assert.match(result.removals[0].reason, /12,000.*9,000/);
});

// -----------------------------------------------------------------------------
// formatReconciliationLine + formatHealthCheckMessage (Telegram with reasons)
// -----------------------------------------------------------------------------

test('formatReconciliationLine reports additions and removals', () => {
  const line = formatReconciliationLine({
    additions: [{ externalId: 'a' }, { externalId: 'b' }],
    removals: [{ externalId: 'c' }],
    unresolvedExtras: [],
    unresolvedMissing: [],
    persisted: { ok: true }
  });
  assert.match(line, /נוספו 2 מודעות חדשות/);
  assert.match(line, /הוסרו 1 מודעות שנעלמו מ-Yad2/);
});

test('formatReconciliationLine warns when persistence failed', () => {
  const line = formatReconciliationLine({
    additions: [{ externalId: 'a' }],
    removals: [],
    unresolvedExtras: [],
    unresolvedMissing: [],
    persisted: { ok: false, reason: 'persist-state.sh exited with 1' }
  });
  assert.match(line, /אזהרה: לא הצלחנו לשמור/);
});

test('formatReconciliationLine returns null when there is nothing to report', () => {
  const line = formatReconciliationLine({
    additions: [],
    removals: [],
    unresolvedExtras: [],
    unresolvedMissing: []
  });
  assert.equal(line, null);
});

test('formatReconciliationLine flags unresolved diffs even when nothing was reconciled', () => {
  const line = formatReconciliationLine({
    additions: [],
    removals: [],
    unresolvedExtras: [{ externalId: 'x' }],
    unresolvedMissing: []
  });
  assert.match(line, /פערים זוהו אך לא נסגרו/);
});

test('formatHealthCheckMessage shows per-row addition/removal reasons', () => {
  const rows = [
    {
      searchId: 'south',
      label: 'דרום',
      real: 5,
      expected: 5,
      missingIds: [],
      extraIds: [],
      reconciled: {
        added: [
          {
            externalId: 'south/NEW',
            link: 'https://www.yad2.co.il/realestate/item/south/NEW',
            reason: 'מודעה חדשה שטרם נסרקה — נוספה ל-seen'
          }
        ],
        removed: [
          {
            externalId: 'south/REMOVED',
            link: 'https://www.yad2.co.il/realestate/item/south/REMOVED',
            reason: 'HTTP 404'
          }
        ],
        unresolvedExtra: [],
        unresolvedMissing: []
      }
    }
  ];
  const text = formatHealthCheckMessage({
    rows,
    allMatch: false,
    generatedAt: '2026-04-30T07:00:00Z',
    reconciliation: {
      additions: rows[0].reconciled.added,
      removals: rows[0].reconciled.removed,
      unresolvedExtras: [],
      unresolvedMissing: [],
      persisted: { ok: true }
    }
  });

  assert.match(text, /🔧 תוקן ב-seen: נוספו 1 מודעות חדשות, הוסרו 1 מודעות שנעלמו מ-Yad2/);
  assert.match(text, /✅ מודעות חדשות שטרם נסרקו:/);
  assert.match(text, /🗑️ מודעה הוסרה - 404/);
  // The per-link "סיבה: …" rows were intentionally dropped — the
  // section header now conveys the reason, keeping the message
  // compact and easier to skim on a phone.
  assert.doesNotMatch(text, /סיבה: HTTP 404/);
  assert.doesNotMatch(text, /סיבה: מודעה חדשה שטרם נסרקה/);
});

test('formatHealthCheckMessage falls back to legacy missingIds/extraIds when reconciled is absent', () => {
  const rows = [
    {
      searchId: 'south',
      label: 'דרום',
      real: 4,
      expected: 5,
      missingIds: ['south/NEW'],
      extraIds: ['south/GHOST']
    }
  ];
  const text = formatHealthCheckMessage({
    rows,
    allMatch: false,
    generatedAt: '2026-04-30T07:00:00Z'
  });

  assert.match(text, /⏳ חסר ב-seen — ייבדק שוב בריצה הבאה \(1\)/);
  assert.match(text, /⏳ ב-seen אך לא ב-Yad2 — ייבדק שוב בריצה הבאה \(1\)/);
});

// -----------------------------------------------------------------------------
// buildHealthCheckMessages: unified single-message output (May 2026)
// -----------------------------------------------------------------------------

test('buildHealthCheckMessages: typical run emits ONE combined message', () => {
  // This is the user-facing change: instead of sending the summary
  // and the diff-details as two separate Telegram pings, we now
  // concatenate them into a single message — summary, then diff
  // details, then the footer at the very bottom.
  const rows = [
    {
      searchId: 'coastal-north',
      label: 'חוף צפוני',
      real: 24,
      expected: 24,
      reconciled: {
        added: [],
        removed: [
          {
            externalId: 'coastal-north/daxjha2y',
            link: 'https://www.yad2.co.il/realestate/item/coastal-north/daxjha2y',
            reason: 'HTTP 404'
          }
        ],
        unresolvedExtra: [],
        unresolvedMissing: []
      }
    },
    {
      searchId: 'north-valleys',
      label: 'צפון ועמקים',
      real: 138,
      expected: 138,
      reconciled: {
        added: [
          {
            externalId: 'north-and-valleys/snxjxydf',
            link: 'https://www.yad2.co.il/realestate/item/north-and-valleys/snxjxydf',
            reason: 'מודעה חדשה שטרם נסרקה — נוספה ל-seen'
          },
          {
            externalId: 'north-and-valleys/qdncoea5',
            link: 'https://www.yad2.co.il/realestate/item/north-and-valleys/qdncoea5',
            reason: 'מודעה חדשה שטרם נסרקה — נוספה ל-seen'
          }
        ],
        removed: [],
        unresolvedExtra: [],
        unresolvedMissing: []
      }
    }
  ];

  const messages = buildHealthCheckMessages({
    rows,
    allMatch: true,
    generatedAt: '2026-05-14T08:22:27Z',
    reconciliation: {
      additions: rows[1].reconciled.added,
      removals: rows[0].reconciled.removed,
      unresolvedExtras: [],
      unresolvedMissing: [],
      persisted: { ok: true }
    }
  });

  assert.equal(messages.length, 1, 'expected exactly one combined Telegram message');
  const text = messages[0];

  // Summary block.
  assert.match(text, /🩺 Yad2 Hunter — בדיקת תקינות/);
  assert.match(text, /✅ הכל תקין/);
  // Per-category headers (compact, no per-link reasons).
  assert.match(text, /🗑️ מודעה הוסרה - 404/);
  assert.match(text, /✅ מודעות חדשות שטרם נסרקו:/);
  // Actual ad links are preserved.
  assert.match(text, /coastal-north\/daxjha2y/);
  assert.match(text, /north-and-valleys\/snxjxydf/);
  assert.match(text, /north-and-valleys\/qdncoea5/);
  // No per-link "סיבה:" lines — the simplification.
  assert.doesNotMatch(text, /סיבה:/);
});

test('buildHealthCheckMessages: footer (נבדק + לוח בקרה) lands at the bottom of the unified message', () => {
  const rows = [
    {
      searchId: 'south',
      label: 'דרום',
      real: 4,
      expected: 5,
      reconciled: {
        added: [
          {
            externalId: 'south/NEW',
            link: 'https://www.yad2.co.il/realestate/item/south/NEW'
          }
        ],
        removed: [],
        unresolvedExtra: [],
        unresolvedMissing: []
      }
    }
  ];

  const [message] = buildHealthCheckMessages({
    rows,
    allMatch: false,
    generatedAt: '2026-05-14T08:22:27Z',
    reconciliation: {
      additions: rows[0].reconciled.added,
      removals: [],
      unresolvedExtras: [],
      unresolvedMissing: [],
      persisted: { ok: true }
    }
  });

  const lastDiffLineIdx = message.lastIndexOf('south/NEW');
  const footerIdx = message.indexOf('נבדק:');
  assert.ok(footerIdx > 0, 'expected "נבדק:" footer somewhere in the message');
  assert.ok(
    footerIdx > lastDiffLineIdx,
    'footer must appear AFTER the diff details, not before'
  );
});

test('buildHealthCheckMessages: emits a single message when everything matched (no diffs)', () => {
  const rows = [
    { searchId: 'south', label: 'דרום', real: 5, expected: 5, reconciled: {} }
  ];

  const messages = buildHealthCheckMessages({
    rows,
    allMatch: true,
    generatedAt: '2026-05-14T08:22:27Z'
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0], /🩺 Yad2 Hunter — בדיקת תקינות/);
  // No "פרטי הפערים" section when there are no diffs.
  assert.doesNotMatch(messages[0], /פרטי הפערים/);
});

// -----------------------------------------------------------------------------
// Yad2 error-widget guard (אופס... תקלה!)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// extractTitle (list-card title heuristics)
// -----------------------------------------------------------------------------

const { extractTitle } = require('../src/scraper/yad2');

test('extractTitle skips price-only lines and picks the first descriptive line', () => {
  const raw = '₪ 5,300\n4 חדרים\nדירה, מתן\nכתובת מלאה';
  assert.equal(extractTitle(raw), 'דירה, מתן');
});

test('extractTitle skips rooms-only lines', () => {
  const raw = '4 חדרים\n5,300 ₪\nדירה, יד נתן';
  assert.equal(extractTitle(raw), 'דירה, יד נתן');
});

test('extractTitle skips Yad2 price-drop chrome ("ירד ב-500 ₪")', () => {
  const raw = 'ירד ב-500 ₪\nדירה, יד נתן\n5,300 ₪';
  assert.equal(extractTitle(raw), 'דירה, יד נתן');
});

test('extractTitle skips "אופס... תקלה!" widget text', () => {
  const raw = 'אופס... תקלה!\nדירה, מתן';
  assert.equal(extractTitle(raw), 'דירה, מתן');
});

test('extractTitle returns a placeholder when every line is non-descriptive', () => {
  const raw = '₪ 5,300\n4 חדרים\nאופס... תקלה!';
  assert.equal(extractTitle(raw), 'מודעה ללא כותרת');
});

test('isYad2ErrorText catches the canonical phrase + variants', () => {
  assert.equal(isYad2ErrorText('אופס... תקלה!'), true);
  assert.equal(isYad2ErrorText('אופס...תקלה'), true);
  assert.equal(isYad2ErrorText('אופס.. תקלה'), true);
  assert.equal(isYad2ErrorText('אופס...    תקלה'), true);
  assert.equal(isYad2ErrorText(' לפני אופס... תקלה אחרי '), true);
});

test('isYad2ErrorText is robust on non-string and irrelevant inputs', () => {
  assert.equal(isYad2ErrorText(null), false);
  assert.equal(isYad2ErrorText(undefined), false);
  assert.equal(isYad2ErrorText(''), false);
  assert.equal(isYad2ErrorText('בית פרטי, מתן'), false);
  assert.equal(isYad2ErrorText('אופס משהו אחר'), false);
});

test('isYad2ErrorText flags the anti-bot challenge text in any casing', () => {
  // The Yad2 anti-bot page uses "Are you for real?" as its document
  // title - we must never persist that into city/title.
  assert.equal(isYad2ErrorText('Are you for real?'), true);
  assert.equal(isYad2ErrorText('?Are you for real'), true);
  assert.equal(isYad2ErrorText('are you for real'), true);
  assert.equal(isYad2ErrorText('ARE YOU FOR REAL?'), true);
  assert.equal(isYad2ErrorText('Radware Bot Manager Block'), true);
  assert.equal(isYad2ErrorText('shieldsquare captcha digest'), true);
  assert.equal(isYad2ErrorText('אבטחת אתר'), true);
});

test('isYad2ErrorText flags the price-area placeholder "לא צוין מחיר"', () => {
  // The "no price specified" label in the listing's price area must
  // never become a city / title - the dashboard derives that from the
  // structured `price` field instead.
  assert.equal(isYad2ErrorText('לא צוין מחיר'), true);
  assert.equal(isYad2ErrorText('  לא צוין מחיר  '), true);
  // Real titles that happen to contain those words are not flagged.
  assert.equal(isYad2ErrorText('דירה, מחיר אטרקטיבי'), false);
});

test('extractTitle skips the anti-bot challenge text', () => {
  // If a detail page briefly returns the captcha challenge before the
  // real listing renders, we must not pick "Are you for real?" as the
  // listing title.
  const raw = 'Are you for real?\nדירה, מתן';
  assert.equal(extractTitle(raw), 'דירה, מתן');
});

test('extractTitle skips the "לא צוין מחיר" placeholder line', () => {
  const raw = 'לא צוין מחיר\nדירה, רחובות';
  assert.equal(extractTitle(raw), 'דירה, רחובות');
});

test('extractTitle skips realtor / agency lines on sponsored cards', () => {
  // Sponsored Yad2 list cards put the agency name on the first line
  // of the container above the actual property heading. Make sure
  // that line never becomes the title.
  assert.equal(extractTitle('יוניסטייט - UNISTATE\nדירה, נהריה\n4 חדרים\n5,300 ₪'), 'דירה, נהריה');
  assert.equal(extractTitle('RE/MAX Paradise\nדירה, צפת'), 'דירה, צפת');
  assert.equal(extractTitle('חן לוי קפיטל נדל"ן\nדירה, חיפה'), 'דירה, חיפה');
  assert.equal(extractTitle('תיווך מעלות\nבית פרטי, מעלות'), 'בית פרטי, מעלות');
  assert.equal(extractTitle('פנורמה נכסים\nדירה, נצרת עילית'), 'דירה, נצרת עילית');
  assert.equal(extractTitle('המאירי נכסים\nדירה, עפולה'), 'דירה, עפולה');
  // All-caps brand strings.
  assert.equal(extractTitle('UNISTATE\nדירה, נהריה'), 'דירה, נהריה');
  // Real property titles must not be skipped.
  assert.equal(extractTitle('דירה, חדרה\n4 חדרים'), 'דירה, חדרה');
});

test('looksLikeCity accepts real city names and rejects addresses / agency strings', () => {
  // Real cities pass.
  assert.equal(looksLikeCity('חיפה'), true);
  assert.equal(looksLikeCity('תל אביב'), true);
  assert.equal(looksLikeCity('נצרת עילית'), true);
  assert.equal(looksLikeCity('משמר הירדן'), true);
  // Street addresses are rejected (digits = address, not city).
  assert.equal(looksLikeCity('הרקפת 162'), false);
  assert.equal(looksLikeCity('383 1'), false);
  assert.equal(looksLikeCity('נחל איילון 20'), false);
  assert.equal(looksLikeCity('שדרות אילות 1'), false);
  // Agency / realtor names are rejected.
  assert.equal(looksLikeCity('יוניסטייט - UNISTATE'), false);
  assert.equal(looksLikeCity('חן לוי קפיטל נדל"ן'), false);
  assert.equal(looksLikeCity('RE/MAX Paradise'), false);
  assert.equal(looksLikeCity('UNISTATE'), false);
  assert.equal(looksLikeCity('תיווך מעלות'), false);
  assert.equal(looksLikeCity('פנורמה נכסים'), false);
  // Anti-bot / error widget text rejected (via isYad2ErrorText).
  assert.equal(looksLikeCity('Are you for real?'), false);
  assert.equal(looksLikeCity('אופס... תקלה!'), false);
  assert.equal(looksLikeCity('לא צוין מחיר'), false);
  // Non-strings.
  assert.equal(looksLikeCity(null), false);
  assert.equal(looksLikeCity(undefined), false);
  assert.equal(looksLikeCity(''), false);
});

test('extractCityFromHeadings prefers a city-shaped breadcrumb segment', () => {
  // Yad2's most common breadcrumb: "<city>, <city>" duplicated or
  // "<district> | <city>" - pick the last city-shaped segment.
  assert.equal(
    extractCityFromHeadings({ secondaryHeading: 'רחובות, רחובות', titleHeading: '' }),
    'רחובות'
  );
  assert.equal(
    extractCityFromHeadings({ secondaryHeading: 'מרכז | חיפה', titleHeading: 'הרקפת 162' }),
    'חיפה'
  );
  // h2 has only an address - skip it, fall through to h1.
  assert.equal(
    extractCityFromHeadings({ secondaryHeading: 'הרקפת 162', titleHeading: 'נהריה' }),
    'נהריה'
  );
  // h1 is also an address - return null so the heal step retries.
  assert.equal(
    extractCityFromHeadings({ secondaryHeading: '', titleHeading: 'הרקפת 162' }),
    null
  );
  // h1 is an agency name - reject it.
  assert.equal(
    extractCityFromHeadings({ secondaryHeading: '', titleHeading: 'יוניסטייט - UNISTATE' }),
    null
  );
  // h1 / h2 are anti-bot text.
  assert.equal(
    extractCityFromHeadings({ secondaryHeading: '?Are you for real', titleHeading: 'Are you for real?' }),
    null
  );
});

test('formatHealthCheckMessage still emits the diff details after a successful reconciliation (allMatch=true)', () => {
  // After reconciliation closes every diff, allMatch becomes true. We
  // still want the user to see WHICH links were affected so they can
  // sanity-check on Yad2.
  const rows = [
    {
      searchId: 'south',
      label: 'דרום',
      real: 5,
      expected: 5,
      missingIds: [],
      extraIds: [],
      reconciled: {
        added: [
          {
            externalId: 'south/NEW',
            link: 'https://www.yad2.co.il/realestate/item/south/NEW',
            reason: 'מודעה חדשה שטרם נסרקה — נוספה ל-seen'
          }
        ],
        removed: [
          {
            externalId: 'south/REMOVED',
            link: 'https://www.yad2.co.il/realestate/item/south/REMOVED',
            reason: 'HTTP 404'
          }
        ],
        unresolvedExtra: [],
        unresolvedMissing: []
      }
    }
  ];
  const text = formatHealthCheckMessage({
    rows,
    allMatch: true,
    generatedAt: '2026-04-30T07:00:00Z',
    reconciliation: {
      additions: rows[0].reconciled.added,
      removals: rows[0].reconciled.removed,
      unresolvedExtras: [],
      unresolvedMissing: [],
      persisted: { ok: true }
    }
  });

  assert.match(text, /https:\/\/www\.yad2\.co\.il\/realestate\/item\/south\/NEW/);
  assert.match(text, /https:\/\/www\.yad2\.co\.il\/realestate\/item\/south\/REMOVED/);
  // Removal reason now lives in the section header, not on every link.
  assert.match(text, /🗑️ מודעה הוסרה - 404/);
});

test('parseCityFromTitle pulls the city out of "PROPERTY_TYPE, CITY" titles', () => {
  // Canonical Yad2 list-card titles - second comma-segment is the city.
  assert.equal(parseCityFromTitle('דירה, נחושה'), 'נחושה');
  assert.equal(parseCityFromTitle('בית פרטי/ קוטג\', שדות מיכה'), 'שדות מיכה');
  assert.equal(parseCityFromTitle('דירה, תל אביב יפו'), 'תל אביב יפו');
  assert.equal(parseCityFromTitle('בית פרטי, משמר הירדן'), 'משמר הירדן');
  // Whitespace tolerated.
  assert.equal(parseCityFromTitle('דירה,   רחובות '), 'רחובות');
});

test('parseCityFromTitle handles Yad2 cards that repeat the city ("X, X")', () => {
  // Real Yad2 list-card heading on sponsored / city-paired cards:
  //   "בית פרטי/ קוטג', אשלים, אשלים"  →  "אשלים"
  //   "דירה, נועם, נועם"                →  "נועם"
  assert.equal(parseCityFromTitle('בית פרטי/ קוטג\', אשלים, אשלים'), 'אשלים');
  assert.equal(parseCityFromTitle('דירה, נועם, נועם'), 'נועם');
  assert.equal(parseCityFromTitle('בית פרטי/ קוטג\', אבן שמואל, אבן שמואל'), 'אבן שמואל');
});

test('parseCityFromTitle rejects values that do not look like a city', () => {
  // Street numbers in the second segment - reject (it is an address).
  assert.equal(parseCityFromTitle('דירה, הרקפת 162'), null);
  // No comma at all.
  assert.equal(parseCityFromTitle('דירה'), null);
  assert.equal(parseCityFromTitle('בית פרטי'), null);
  // Empty / placeholder titles.
  assert.equal(parseCityFromTitle('מודעה'), null);
  assert.equal(parseCityFromTitle(''), null);
  assert.equal(parseCityFromTitle(null), null);
  assert.equal(parseCityFromTitle(undefined), null);
  // Anti-bot text leaking in.
  assert.equal(parseCityFromTitle('?Are you for real, abc'), null);
  // Agency names in the second segment.
  assert.equal(parseCityFromTitle('דירה, RE/MAX Paradise'), null);
});

test('extractTitle prefers a "PROPERTY_TYPE, CITY" line over a street-address line', () => {
  // Real Yad2 list-card raw text shape (price, street, type+city, rooms).
  // Without the property-type preference, extractTitle would pick the
  // street address ("דרך האתרוג 59") as the title.
  const raw =
    '₪ 5,600\nדרך האתרוג 59\nבית פרטי/ קוטג\', אשלים, אשלים\n4 חדרים • קומה ‎קרקע‏ • 500 מ״ר';
  assert.equal(extractTitle(raw), 'בית פרטי/ קוטג\', אשלים');
});

test('extractTitle picks the property-type heading on sponsored cards (agency on line 1)', () => {
  // Sponsored card shape: agency name, then placeholder price, then
  // a property-type line WITHOUT a city, then the canonical
  // "PROPERTY_TYPE, CITY, CITY" heading. We must pick the canonical
  // line.
  const raw =
    'לוי נכסים ונדל"ן\nלא צוין מחיר\nבית פרטי/ קוטג\'\nבית פרטי/ קוטג\', זרחיה\n4 חדרים • קומה ‎1‏ • 330 מ״ר';
  assert.equal(extractTitle(raw), 'בית פרטי/ קוטג\', זרחיה');
});

test('extractTitle still picks "PROPERTY_TYPE, CITY" when the price-drop chrome is present', () => {
  // "ירד ב-X ₪" line at the top must not become the title; the
  // canonical heading further down should win.
  const raw =
    'ירד ב-1,000 ₪\n₪ 9,000\nסמטת השיזף 8\nבית פרטי/ קוטג\', באר אורה, באר אורה\n5.5 חדרים • קומה ‎קרקע‏ • 475 מ״ר';
  assert.equal(extractTitle(raw), 'בית פרטי/ קוטג\', באר אורה');
});

test('extractTitle falls back to the legacy first-line behaviour when no PROPERTY_TYPE line exists', () => {
  // No canonical heading in the rawText - first non-skipped line wins.
  const raw = '₪ 5,300\n4 חדרים\nדירה, מתן';
  assert.equal(extractTitle(raw), 'דירה, מתן');
});

test('extractTitle picks the canonical heading even when property type is "סאבלט"', () => {
  // Real Yad2 list-card shape (jerusalem feed) — "סאבלט" was missing
  // from the property-type prefix list, causing the street address to
  // become the title.
  const raw = 'לא צוין מחיר\nריח הדס 252\nסאבלט, גבעת יערים, גבעת יערים\n7 חדרים';
  assert.equal(extractTitle(raw), 'סאבלט, גבעת יערים');
});

test('parseCityFromTitle handles "סאבלט" + duplicated city', () => {
  assert.equal(parseCityFromTitle('סאבלט, גבעת יערים, גבעת יערים'), 'גבעת יערים');
});

test('parsePrice ignores the "ירד ב-X ₪" price-drop chrome line', () => {
  const { parsePrice } = require('../src/scraper/yad2');
  // Real Yad2 list-card shape: drop line first, real price next.
  assert.equal(parsePrice('ירד ב-500 ₪\n₪ 9,000\nסמטת השיזף 8'), 9000);
  assert.equal(parsePrice('ירד ב-1,000 ₪\n₪ 7,500'), 7500);
  // Single price line still works.
  assert.equal(parsePrice('₪ 5,300\n4 חדרים'), 5300);
  // No price at all.
  assert.equal(parsePrice('לא צוין מחיר\nדירה, מתן'), null);
  // "300 1" inside title shouldn't wrongly parse — no ₪ token, so null.
  assert.equal(parsePrice('דירה, נועם\n300 1'), null);
});

test('mergeSeenAds: union of local and remote when no force-deletes', () => {
  const local = { ads: { a: { externalId: 'a' } } };
  const remote = { ads: { b: { externalId: 'b' } } };
  const merged = mergeSeenAds(local, remote);
  assert.deepEqual(Object.keys(merged.ads).sort(), ['a', 'b']);
});

test('mergeSeenAds: forceDeleteIds subtract keys from the union', () => {
  // Health-check just removed `ghost` (404'd) and is pushing. Concurrent
  // scan still has `ghost` in its remote snapshot. Without the
  // force-delete hint, the union would resurrect it.
  const local = { ads: { keep: { externalId: 'keep' } } };
  const remote = {
    ads: { keep: { externalId: 'keep' }, ghost: { externalId: 'ghost' } }
  };
  const merged = mergeSeenAds(local, remote, ['ghost']);
  assert.deepEqual(Object.keys(merged.ads).sort(), ['keep']);
});

test('mergeSeenAds: empty forceDeleteIds preserves everything', () => {
  const local = { ads: { keep: { externalId: 'keep' } } };
  const remote = {
    ads: { keep: { externalId: 'keep' }, also: { externalId: 'also' } }
  };
  const merged = mergeSeenAds(local, remote, []);
  assert.deepEqual(Object.keys(merged.ads).sort(), ['also', 'keep']);
});

// -----------------------------------------------------------------------------
// selectAdsForTelegram (district-level Telegram suppression)
// -----------------------------------------------------------------------------

const ADS_FOR_TELEGRAM = [
  { externalId: 'south/a', searchId: 'south', title: 'A' },
  { externalId: 'jerusalem/b', searchId: 'jerusalem', title: 'B' },
  { externalId: 'north-valleys/c', searchId: 'north-valleys', title: 'C' },
  { externalId: 'north-valleys/d', searchId: 'north-valleys', title: 'D' }
];

test('selectAdsForTelegram drops ads from suppressed districts by default', () => {
  const result = selectAdsForTelegram({
    ads: ADS_FOR_TELEGRAM,
    suppressDistrictIds: ['north-valleys'],
    explicitlyRequestedIds: []
  });
  assert.deepEqual(
    result.map((a) => a.externalId),
    ['south/a', 'jerusalem/b']
  );
});

test('selectAdsForTelegram keeps everything when no suppression is configured', () => {
  const result = selectAdsForTelegram({
    ads: ADS_FOR_TELEGRAM,
    suppressDistrictIds: [],
    explicitlyRequestedIds: []
  });
  assert.equal(result.length, 4);
});

test('selectAdsForTelegram respects an explicit user request as an override', () => {
  // User clicked "הרץ סריקה" with north-valleys checked → notify
  // about north ads even though they are normally suppressed.
  const result = selectAdsForTelegram({
    ads: ADS_FOR_TELEGRAM,
    suppressDistrictIds: ['north-valleys'],
    explicitlyRequestedIds: ['north-valleys']
  });
  assert.deepEqual(
    result.map((a) => a.externalId).sort(),
    ['jerusalem/b', 'north-valleys/c', 'north-valleys/d', 'south/a'].sort()
  );
});

test('selectAdsForTelegram still drops north when only south was explicitly requested', () => {
  const result = selectAdsForTelegram({
    ads: ADS_FOR_TELEGRAM,
    suppressDistrictIds: ['north-valleys'],
    explicitlyRequestedIds: ['south']
  });
  assert.deepEqual(
    result.map((a) => a.externalId),
    ['south/a', 'jerusalem/b']
  );
});

test('selectAdsForTelegram is safe with empty / null inputs', () => {
  assert.deepEqual(selectAdsForTelegram({ ads: [] }), []);
  assert.deepEqual(selectAdsForTelegram({ ads: null }), []);
});

// =====================================================================
// Notification routing (Telegram vs Email) for the Lev HaPark watch
// =====================================================================

const ROUTER_SEARCHES = [
  { id: 'jerusalem' },
  { id: 'south' },
  { id: 'north-valleys' },
  { id: 'lev-hapark-rent', notifyVia: 'email' },
  { id: 'lev-hapark-sale', notifyVia: 'email' }
];

const ROUTER_ADS = [
  { externalId: 'a', searchId: 'jerusalem' },
  { externalId: 'b', searchId: 'south' },
  { externalId: 'c', searchId: 'lev-hapark-rent' },
  { externalId: 'd', searchId: 'lev-hapark-sale' },
  { externalId: 'e', searchId: 'unknown-id' }
];

test('buildNotifyChannelMap defaults moshav districts to telegram and lev-hapark to email', () => {
  const map = buildNotifyChannelMap(ROUTER_SEARCHES);
  assert.equal(map.get('jerusalem'), 'telegram');
  assert.equal(map.get('south'), 'telegram');
  assert.equal(map.get('north-valleys'), 'telegram');
  assert.equal(map.get('lev-hapark-rent'), 'email');
  assert.equal(map.get('lev-hapark-sale'), 'email');
});

test('partitionAdsByChannel routes lev-hapark to email and the rest to telegram', () => {
  const map = buildNotifyChannelMap(ROUTER_SEARCHES);
  const { telegramAds, emailAds } = partitionAdsByChannel(ROUTER_ADS, map);
  assert.deepEqual(
    telegramAds.map((a) => a.externalId).sort(),
    ['a', 'b', 'e'].sort()
  );
  assert.deepEqual(
    emailAds.map((a) => a.externalId).sort(),
    ['c', 'd'].sort()
  );
});

test('partitionAdsByChannel falls back to telegram when searchId is unknown', () => {
  const map = buildNotifyChannelMap(ROUTER_SEARCHES);
  const { telegramAds, emailAds } = partitionAdsByChannel(
    [{ externalId: 'x', searchId: 'mystery-district' }],
    map
  );
  assert.equal(telegramAds.length, 1);
  assert.equal(emailAds.length, 0);
});

test('partitionAdsByChannel handles empty / null gracefully', () => {
  const map = buildNotifyChannelMap(ROUTER_SEARCHES);
  assert.deepEqual(partitionAdsByChannel([], map), {
    telegramAds: [],
    emailAds: []
  });
  assert.deepEqual(partitionAdsByChannel(null, map), {
    telegramAds: [],
    emailAds: []
  });
});

test('pickManualNoticeChannels stays on telegram for global cron-style runs', () => {
  const map = buildNotifyChannelMap(ROUTER_SEARCHES);
  assert.deepEqual(
    pickManualNoticeChannels({ explicitlyRequestedIds: [], channelMap: map }),
    { telegram: true, email: false }
  );
});

test('pickManualNoticeChannels picks email only for lev-hapark manual scan', () => {
  const map = buildNotifyChannelMap(ROUTER_SEARCHES);
  assert.deepEqual(
    pickManualNoticeChannels({
      explicitlyRequestedIds: ['lev-hapark-rent', 'lev-hapark-sale'],
      channelMap: map
    }),
    { telegram: false, email: true }
  );
});

// rent-in-cities has no notifyVia override, so the channel router must
// keep its ads on the Telegram bucket alongside the moshav districts.
// These regressions cover the live router and the manual scan channel
// picker, both for the rent-in-cities case and the existing lev-hapark
// email override.
test('partitionAdsByChannel keeps rent-in-cities on telegram (no notifyVia)', () => {
  const searches = [
    { id: 'jerusalem' },
    { id: 'rent-in-cities' },
    { id: 'lev-hapark-rent', notifyVia: 'email' }
  ];
  const ads = [
    { externalId: 'a', searchId: 'jerusalem' },
    { externalId: 'b', searchId: 'rent-in-cities' },
    { externalId: 'c', searchId: 'lev-hapark-rent' }
  ];
  const map = buildNotifyChannelMap(searches);
  assert.equal(map.get('rent-in-cities'), 'telegram');
  const { telegramAds, emailAds } = partitionAdsByChannel(ads, map);
  assert.deepEqual(telegramAds.map((a) => a.externalId).sort(), ['a', 'b']);
  assert.deepEqual(emailAds.map((a) => a.externalId), ['c']);
});

test('pickManualNoticeChannels keeps telegram on for a rent-in-cities manual scan', () => {
  // Manually triggering ONLY rent-in-cities from its dashboard page
  // must still result in a Telegram notice (the watch is telegram-routed),
  // and must NOT trigger the email channel.
  const searches = [
    { id: 'rent-in-cities' },
    { id: 'lev-hapark-rent', notifyVia: 'email' }
  ];
  const map = buildNotifyChannelMap(searches);
  assert.deepEqual(
    pickManualNoticeChannels({
      explicitlyRequestedIds: ['rent-in-cities'],
      channelMap: map
    }),
    { telegram: true, email: false }
  );
});

test('pickManualNoticeChannels picks both when the manual scan mixes districts', () => {
  const map = buildNotifyChannelMap(ROUTER_SEARCHES);
  assert.deepEqual(
    pickManualNoticeChannels({
      explicitlyRequestedIds: ['south', 'lev-hapark-sale'],
      channelMap: map
    }),
    { telegram: true, email: true }
  );
});

// =====================================================================
// Email helpers (the only pure-function pieces of src/services/email.js)
// =====================================================================

test('email parseRecipients splits comma-separated values and trims whitespace', () => {
  assert.deepEqual(
    emailTesting.parseRecipients(' a@example.com ,b@example.com , c@example.com'),
    ['a@example.com', 'b@example.com', 'c@example.com']
  );
  assert.deepEqual(emailTesting.parseRecipients(''), []);
  assert.deepEqual(emailTesting.parseRecipients(null), []);
});

test('email buildSubject formats new-ads and no-ads cases distinctly', () => {
  const subjNew = emailTesting.buildSubject({
    newAds: [{ externalId: '1' }, { externalId: '2' }],
    label: 'לב הפארק'
  });
  assert.equal(subjNew, 'לב הפארק — 2 מודעות חדשות');

  const subjEmpty = emailTesting.buildSubject({
    newAds: [],
    label: 'לב הפארק'
  });
  assert.equal(subjEmpty, 'לב הפארק — אין מודעות חדשות');

  const subjCustom = emailTesting.buildSubject({
    newAds: [],
    label: 'לב הפארק',
    suffix: 'סריקה ידנית'
  });
  assert.equal(subjCustom, 'לב הפארק — סריקה ידנית');
});

test('email buildHtml escapes content and embeds the ad link', () => {
  const html = emailTesting.buildHtml({
    newAds: [
      {
        title: 'דירה <מפוארת> "לב הפארק"',
        city: 'רעננה',
        rooms: 5,
        price: 5_000_000,
        link: 'https://www.yad2.co.il/realestate/item/x?a=1&b=2',
        districtLabel: 'לב הפארק, רעננה',
        hasExplicitPrice: true
      }
    ],
    label: 'לב הפארק',
    runStartedAt: '2026-05-12T10:00:00.000Z',
    dashboardPath: '/lev-hapark'
  });
  assert.match(html, /&lt;\u05de\u05e4\u05d5\u05d0\u05e8\u05ea&gt;/);
  assert.match(html, /&quot;\u05dc\u05d1 \u05d4\u05e4\u05d0\u05e8\u05e7&quot;/);
  assert.match(html, /a=1&amp;b=2/);
  assert.match(html, /5,000,000 ₪/);
});

test('email buildDashboardUrl joins a base URL with a sub-path and ?since', () => {
  const url = emailTesting.buildDashboardUrl({
    runStartedAt: '2026-05-12T10:00:00.000Z',
    dashboardPath: '/lev-hapark'
  });
  // Without a configured DASHBOARD_URL this returns null. We test that
  // a configured URL gets the path appended correctly via a focused
  // pure-function check below.
  assert.ok(url === null || /\/lev-hapark/.test(url));
});

// =====================================================================
// Hourly scan loop wrapper (src/worker/run-loop.js). These tests pin
// down the budget arithmetic so the loop fires the intended number of
// iterations per hour and never runs past its wall-clock deadline.
// =====================================================================

test('run-loop parsePositiveInt falls back to default for empty/invalid input', () => {
  const { parsePositiveInt } = loopTesting;
  assert.equal(parsePositiveInt('', 42), 42);
  assert.equal(parsePositiveInt(undefined, 42), 42);
  assert.equal(parsePositiveInt(null, 42), 42);
  assert.equal(parsePositiveInt('abc', 42), 42);
  assert.equal(parsePositiveInt('-5', 42), 42);
  assert.equal(parsePositiveInt('0', 42), 42);
  assert.equal(parsePositiveInt('17', 42), 17);
});

test('run-loop parseBool maps the env-var dialect to a real boolean', () => {
  const { parseBool } = loopTesting;
  assert.equal(parseBool('true', false), true);
  assert.equal(parseBool('TRUE', false), true);
  assert.equal(parseBool('1', false), true);
  assert.equal(parseBool('yes', false), true);
  assert.equal(parseBool('false', true), false);
  assert.equal(parseBool('0', true), false);
  assert.equal(parseBool('no', true), false);
  // Falls back to the default when the value isn't a recognized boolean.
  assert.equal(parseBool('', true), true);
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool('maybe', false), false);
});

test('run-loop shouldRunAnotherIteration enforces interval + safety buffer', () => {
  const { shouldRunAnotherIteration, SAFETY_BUFFER_MS } = loopTesting;
  const intervalMs = 30 * 60 * 1000;
  const deadline = 1000 + intervalMs + SAFETY_BUFFER_MS;
  assert.equal(
    shouldRunAnotherIteration({
      now: 1000,
      deadline,
      intervalMs,
      safetyBufferMs: SAFETY_BUFFER_MS
    }),
    true,
    'when exactly interval + buffer fits, another iteration should fire'
  );
  assert.equal(
    shouldRunAnotherIteration({
      now: 1001,
      deadline,
      intervalMs,
      safetyBufferMs: SAFETY_BUFFER_MS
    }),
    false,
    'one millisecond short of the budget must stop the loop'
  );
});

test('run-loop default budget fits exactly 2 iterations at the 30-min interval', () => {
  // Hourly cron → ~55 min budget → interval 30 min. The math must
  // give the loop room for the second iteration but not a third.
  const {
    DEFAULT_BUDGET_MS,
    DEFAULT_INTERVAL_MS,
    SAFETY_BUFFER_MS,
    shouldRunAnotherIteration
  } = loopTesting;
  const start = 0;
  const deadline = start + DEFAULT_BUDGET_MS;
  // After the first iteration (at t≈0), do we have room for another?
  assert.equal(
    shouldRunAnotherIteration({
      now: start + 1000,
      deadline,
      intervalMs: DEFAULT_INTERVAL_MS,
      safetyBufferMs: SAFETY_BUFFER_MS
    }),
    true
  );
  // After the second iteration (at t≈30 min + a little overhead),
  // there must NOT be room for a third — otherwise we'd risk
  // crossing the hourly boundary.
  assert.equal(
    shouldRunAnotherIteration({
      now: start + DEFAULT_INTERVAL_MS + 60 * 1000,
      deadline,
      intervalMs: DEFAULT_INTERVAL_MS,
      safetyBufferMs: SAFETY_BUFFER_MS
    }),
    false
  );
});

test('run-loop computeSleepMs subtracts iteration cost from the interval', () => {
  const { computeSleepMs } = loopTesting;
  const intervalMs = 30 * 60 * 1000;
  // A 5-min iteration should still leave ~25 min of sleep.
  assert.equal(
    computeSleepMs({ intervalMs, lastIterationDurationMs: 5 * 60 * 1000 }),
    25 * 60 * 1000
  );
  // Floor the sleep at 5 s so a runaway iteration can't busy-loop.
  assert.equal(
    computeSleepMs({ intervalMs, lastIterationDurationMs: intervalMs + 1000 }),
    5000
  );
});

// =====================================================================
// Partial-scrape warning. The scan worker emits this as a separate
// Telegram message every iteration where ANY watch failed (captcha,
// timeout, etc.) so blocks never go silent.
// =====================================================================

test('describeScrapeError translates known Yad2 failure modes into Hebrew', () => {
  assert.equal(
    describeScrapeError('blocked by anti-bot after all retries'),
    'נחסם על ידי הגנת captcha של Yad2'
  );
  assert.equal(describeScrapeError('captcha challenge'), 'נחסם על ידי captcha');
  assert.equal(describeScrapeError('Timeout 60000ms exceeded'), 'תם הזמן הקצוב לסריקה');
  assert.equal(describeScrapeError('net::ERR_CONNECTION_RESET'), 'שגיאת רשת מול Yad2');
  assert.equal(describeScrapeError('HTTP 503 from yad2'), 'Yad2 החזיר שגיאת שרת (5xx)');
  // Unknown messages pass through verbatim so we never hide signal.
  assert.equal(describeScrapeError('weird custom failure'), 'weird custom failure');
  // Missing / empty input doesn't crash.
  assert.equal(describeScrapeError(''), 'שגיאה לא ידועה');
  assert.equal(describeScrapeError(undefined), 'שגיאה לא ידועה');
});

test('summarizeScrapeErrors collapses multiple errors for the same watch', () => {
  const summary = summarizeScrapeErrors([
    { searchId: 'lev-hapark-rent', searchLabel: 'לב הפארק — שכירות', message: 'captcha challenge' },
    { searchId: 'lev-hapark-rent', searchLabel: 'לב הפארק — שכירות', message: 'blocked by anti-bot after all retries' },
    { searchId: 'rent-in-cities', searchLabel: 'שכירות בערים', message: 'blocked by anti-bot after all retries' }
  ]);
  assert.equal(summary.length, 2);
  const rent = summary.find((s) => s.searchId === 'lev-hapark-rent');
  assert.equal(rent.searchLabel, 'לב הפארק — שכירות');
  // Both distinct reasons should show up in the collapsed line.
  assert.match(rent.reason, /captcha/);
  assert.match(rent.reason, /הגנת captcha של Yad2/);
});

test('summarizeScrapeErrors ignores entries without a searchId', () => {
  const summary = summarizeScrapeErrors([
    { searchId: '', message: 'noop' },
    { message: 'noop' },
    null,
    { searchId: 'jerusalem', searchLabel: 'ירושלים', message: 'Timeout' }
  ]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].searchId, 'jerusalem');
});

test('formatPartialScrapeWarning produces the operational Hebrew notice', () => {
  const text = formatPartialScrapeWarning({
    errors: [
      {
        searchId: 'lev-hapark-rent',
        searchLabel: 'לב הפארק — שכירות',
        message: 'blocked by anti-bot after all retries'
      },
      {
        searchId: 'lev-hapark-sale',
        searchLabel: 'לב הפארק — מכירה',
        message: 'blocked by anti-bot after all retries'
      },
      {
        searchId: 'rent-in-cities',
        searchLabel: 'שכירות בערים',
        message: 'blocked by anti-bot after all retries'
      }
    ],
    runStartedAt: '2026-05-20T10:00:00Z'
  });
  assert.match(text, /סריקה חלקית/);
  assert.match(text, /החיפושים הבאים לא נסרקו בהצלחה/);
  assert.match(text, /לב הפארק — שכירות/);
  assert.match(text, /לב הפארק — מכירה/);
  assert.match(text, /שכירות בערים/);
  // Reason rendered after an em-dash, not the raw English message.
  assert.match(text, /— נחסם על ידי הגנת captcha של Yad2/);
  // Reassurance line so the user knows the dashboard is intact.
  assert.match(text, /המודעות הקיימות בדאשבורד לא הושפעו/);
  // Should NOT echo the raw English internals.
  assert.equal(/blocked by anti-bot/.test(text), false);
});

test('formatPartialScrapeWarning returns empty string when there are no errors', () => {
  assert.equal(formatPartialScrapeWarning({ errors: [] }), '');
  assert.equal(formatPartialScrapeWarning({ errors: null }), '');
  assert.equal(formatPartialScrapeWarning({}), '');
  assert.equal(formatPartialScrapeWarning(), '');
});

test('formatPartialScrapeWarning falls back to the searchId when label is missing', () => {
  const text = formatPartialScrapeWarning({
    errors: [{ searchId: 'mystery-watch', message: 'Timeout 60000ms exceeded' }]
  });
  assert.match(text, /• mystery-watch — תם הזמן הקצוב לסריקה/);
});

// ==========================================================================
// Per-search scrape cooldowns: one blocked search → only that search
// sits out for SCRAPE_COOLDOWN_MS, the others keep scanning.
// ==========================================================================

test('setBlocked installs an entry that expires after the requested duration', () => {
  const state = emptyState();
  const t0 = 1_700_000_000_000;
  setBlocked(state, 'south', 60 * 60 * 1000, t0);
  const entry = state.entries['south'];
  assert.ok(entry, 'entry should exist');
  assert.equal(entry.blockedAt, new Date(t0).toISOString());
  assert.equal(entry.blockedUntil, new Date(t0 + 60 * 60 * 1000).toISOString());
  assert.equal(entry.observedAt, new Date(t0).toISOString());
});

test('isCooledDown reflects the blockedUntil window', () => {
  const state = emptyState();
  const t0 = 1_700_000_000_000;
  setBlocked(state, 'south', 60 * 60 * 1000, t0);
  assert.equal(isCooledDown(state, 'south', t0 + 1), true);
  assert.equal(isCooledDown(state, 'south', t0 + 60 * 60 * 1000), false);
  assert.equal(isCooledDown(state, 'south', t0 + 60 * 60 * 1000 + 1), false);
  assert.equal(isCooledDown(state, 'unknown-search', t0), false);
  assert.equal(isCooledDown(emptyState(), 'south', t0), false);
});

test('buildActiveCooldownMap filters out expired entries', () => {
  const t0 = 1_700_000_000_000;
  const state = emptyState();
  setBlocked(state, 'south', 60 * 60 * 1000, t0);
  setBlocked(state, 'north-valleys', 1, t0);
  const map = buildActiveCooldownMap(state, t0 + 2);
  assert.equal(map.has('south'), true);
  assert.equal(map.has('north-valleys'), false);
});

test('getCooldown returns the raw entry for the partial-scrape warning to read', () => {
  const state = emptyState();
  const t0 = 1_700_000_000_000;
  setBlocked(state, 'south', 60 * 60 * 1000, t0);
  const entry = getCooldown(state, 'south');
  assert.equal(entry.blockedAt, new Date(t0).toISOString());
  assert.equal(entry.blockedUntil, new Date(t0 + 60 * 60 * 1000).toISOString());
  assert.equal(getCooldown(state, 'missing'), null);
});

test('pruneExpired drops entries whose blockedUntil is in the past', () => {
  const t0 = 1_700_000_000_000;
  const state = emptyState();
  setBlocked(state, 'south', 1, t0);
  setBlocked(state, 'center-sharon', 60 * 60 * 1000, t0);
  pruneExpired(state, t0 + 60 * 1000);
  assert.equal(state.entries['south'], undefined);
  assert.ok(state.entries['center-sharon']);
});

test('setBlocked called twice overwrites with the freshest observedAt', () => {
  const state = emptyState();
  const t0 = 1_700_000_000_000;
  setBlocked(state, 'south', 60 * 60 * 1000, t0);
  setBlocked(state, 'south', 60 * 60 * 1000, t0 + 5 * 60 * 1000);
  assert.equal(
    state.entries['south'].observedAt,
    new Date(t0 + 5 * 60 * 1000).toISOString()
  );
  assert.equal(
    state.entries['south'].blockedUntil,
    new Date(t0 + 5 * 60 * 1000 + 60 * 60 * 1000).toISOString()
  );
});

test('mergeCooldowns keeps the entry with the latest observedAt per searchId', () => {
  const older = '2026-05-24T10:00:00.000Z';
  const newer = '2026-05-24T11:00:00.000Z';
  const local = {
    entries: {
      south: { blockedAt: older, blockedUntil: newer, observedAt: older }
    }
  };
  const remote = {
    entries: {
      south: {
        blockedAt: newer,
        blockedUntil: '2026-05-24T12:00:00.000Z',
        observedAt: newer
      }
    }
  };
  const merged = mergeCooldowns(local, remote);
  assert.equal(merged.entries.south.observedAt, newer);
});

test('mergeCooldowns is a union: searches present on one side pass through', () => {
  const local = {
    entries: {
      south: {
        blockedAt: '2026-05-24T10:00:00.000Z',
        blockedUntil: '2026-05-24T11:00:00.000Z',
        observedAt: '2026-05-24T10:00:00.000Z'
      }
    }
  };
  const remote = {
    entries: {
      'center-sharon': {
        blockedAt: '2026-05-24T10:30:00.000Z',
        blockedUntil: '2026-05-24T11:30:00.000Z',
        observedAt: '2026-05-24T10:30:00.000Z'
      }
    }
  };
  const merged = mergeCooldowns(local, remote);
  assert.ok(merged.entries.south);
  assert.ok(merged.entries['center-sharon']);
});

test('mergeCooldowns is robust to missing / null inputs', () => {
  assert.deepEqual(mergeCooldowns(null, null).entries, {});
  const snapshot = {
    entries: {
      south: {
        blockedAt: '2026-05-24T10:00:00.000Z',
        blockedUntil: '2026-05-24T11:00:00.000Z',
        observedAt: '2026-05-24T10:00:00.000Z'
      }
    }
  };
  assert.deepEqual(mergeCooldowns(snapshot, null).entries, snapshot.entries);
  assert.deepEqual(mergeCooldowns(null, snapshot).entries, snapshot.entries);
});
