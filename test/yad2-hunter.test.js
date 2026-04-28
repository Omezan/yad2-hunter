const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterRelevantAds,
  getRejection,
  isRelevant
} = require('../src/services/relevance');
const { formatDigestMessage, formatDigestMessages } = require('../src/services/telegram');
const {
  extractExternalId,
  normalizeItemUrl,
  parseFloor,
  parsePublishedDate
} = require('../src/scraper/yad2');
const { removeDeletedAds } = require('../src/store/file-store');

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
