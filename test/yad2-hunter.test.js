const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterRelevantAds,
  getRejection,
  isRelevant
} = require('../src/services/relevance');
const {
  formatDigestMessage,
  formatDigestMessages,
  formatHealthCheckMessage,
  formatManualScanNoNewAdsMessage,
  formatReconciliationLine
} = require('../src/services/telegram');
const {
  extractExternalId,
  isYad2ErrorText,
  normalizeItemUrl,
  parseFloor,
  parsePublishedDate
} = require('../src/scraper/yad2');
const { removeDeletedAds } = require('../src/store/file-store');
const { reconcileSeen } = require('../src/worker/health-check');

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

const { mergeSeenAds, mergeRuns } = require('../scripts/merge-state');

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
  assert.match(text, /✅ נוספו ל-seen \(1\):/);
  assert.match(text, /🗑️ הוסרו מ-seen \(1\):/);
  assert.match(text, /סיבה: HTTP 404/);
  assert.match(text, /סיבה: מודעה חדשה שטרם נסרקה — נוספה ל-seen/);
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

  assert.match(text, /⏳ חסר ב-seen ולא נסגר \(1\)/);
  assert.match(text, /⏳ ב-seen אך לא ב-Yad2 ולא נסגר \(1\)/);
});

// -----------------------------------------------------------------------------
// Yad2 error-widget guard (אופס... תקלה!)
// -----------------------------------------------------------------------------

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
  assert.match(text, /סיבה: HTTP 404/);
});
