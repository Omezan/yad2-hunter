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
  parsePublishedDate
} = require('../src/scraper/yad2');

const ITEM = 'https://www.yad2.co.il/realestate/item/center-and-sharon/abc123';

function makeAd(overrides) {
  return {
    title: 'דירה, בת חפר',
    rawText: 'דירה, בת חפר\n6 חדרים\n7,000 ₪',
    descriptionText: 'דירה ביישוב כפרי, גינה גדולה ופרטיות מלאה',
    locationText: 'בת חפר',
    city: 'בת חפר',
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

test('isRelevant accepts settlements-only ads with valid rooms and price', () => {
  assert.equal(isRelevant(makeAd()), true);
});

test('isRelevant rejects non-item URLs', () => {
  const ad = makeAd({ link: 'https://www.yad2.co.il/commercial-projects/abc' });
  assert.equal(getRejection(ad), 'non-item-url');
});

test('isRelevant rejects ads above the max price', () => {
  const ad = makeAd({ price: 12000 });
  assert.equal(getRejection(ad), 'price:12000');
});

test('isRelevant rejects ads below the minimum rooms', () => {
  const ad = makeAd({ rooms: 3 });
  assert.equal(getRejection(ad), 'rooms:3');
});

test('isRelevant blocks urban ads even when search is settlements-only', () => {
  const ad = makeAd({
    title: 'דירה במרכז',
    rawText: 'דירה במרכז\nתל אביב\n4 חדרים\n8,500 ₪',
    locationText: 'תל אביב',
    city: 'תל אביב',
    descriptionText: 'דירה במרכז העיר'
  });
  assert.equal(getRejection(ad), 'urban-location');
});

test('isRelevant rejects ads with explicit promoted keywords in description', () => {
  const ad = makeAd({
    title: 'פרויקט חדש',
    descriptionText: 'פרויקט חדש בקיבוץ דוגמה'
  });
  assert.equal(getRejection(ad), 'keyword:פרויקט חדש');
});

test('un-enriched ads only get structural pre-filter checks', () => {
  const ad = makeAd({
    enriched: false,
    rawText: 'פרויקט חדש פרסומת\n4 חדרים\n8,500 ₪',
    descriptionText: '',
    locationText: 'תל אביב',
    city: 'תל אביב'
  });
  assert.equal(getRejection(ad), null);
});

test('enriched ads ignore promo keywords found only in the wide rawText', () => {
  const ad = makeAd({
    enriched: true,
    rawText: 'פרויקט חדש פרסומת מסיחת דעת',
    descriptionText: 'בית יפה וגדול עם גינה'
  });
  assert.equal(getRejection(ad), null);
});

test('enriched ads still reject when the description itself mentions the keyword', () => {
  const ad = makeAd({
    enriched: true,
    rawText: '',
    descriptionText: 'בלעדי בפרויקט חדש בקיבוץ דוגמה'
  });
  assert.match(getRejection(ad) || '', /^keyword:(בלעדי בפרויקט|פרויקט חדש)$/);
});

test('enriched ads accept benign property tags like מתאים לשותפים', () => {
  const ad = makeAd({
    enriched: true,
    rawText: '',
    descriptionText: 'דירה יפה בקיבוץ דוגמה, מתאים לשותפים, ממ"ד, מרפסת'
  });
  assert.equal(getRejection(ad), null);
});

test('enriched ads accept חדש מקבלן property condition (newly built rental)', () => {
  const ad = makeAd({
    enriched: true,
    rawText: '',
    descriptionText: 'דירה חדשה מקבלן, לא גרו בה, בקיבוץ דוגמה'
  });
  assert.equal(getRejection(ad), null);
});

test('enriched ads still reject explicit roommate-search ads', () => {
  const ad = makeAd({
    enriched: true,
    rawText: '',
    descriptionText: 'מחפשים שותף לדירה בקיבוץ דוגמה'
  });
  assert.match(getRejection(ad) || '', /^keyword:(מחפשים שותפ|שותף לדירה)$/);
});

test('enriched ads still reject explicit basement units', () => {
  const ad = makeAd({
    enriched: true,
    rawText: '',
    descriptionText: 'יחידת מרתף נחמדה בקיבוץ דוגמה'
  });
  assert.equal(getRejection(ad), 'keyword:יחידת מרתף');
});

test('enriched ads do not match urban blocklist on noisy rawText', () => {
  const ad = makeAd({
    enriched: true,
    rawText: 'בנר חולה: דירות בנתניה',
    descriptionText: 'דירה בקיבוץ דוגמה'
  });
  assert.equal(getRejection(ad), null);
});

test('enriched ads still reject urban listings when city says so', () => {
  const ad = makeAd({
    enriched: true,
    rawText: '',
    city: 'תל אביב',
    locationText: 'תל אביב',
    descriptionText: 'דירה במרכז העיר'
  });
  assert.equal(getRejection(ad), 'urban-location');
});

test('ads without an explicit price are still accepted', () => {
  const ad = makeAd({ price: null, hasExplicitPrice: false });
  assert.equal(getRejection(ad), null);
});

test('requireExplicitRooms rejects ads without a numeric room count', () => {
  const ad = makeAd({ rooms: null });
  assert.equal(getRejection(ad, { requireExplicitRooms: true }), 'no-rooms');
});

test('cross-district suggestion URLs are rejected', () => {
  const ad = makeAd({ link: 'https://www.yad2.co.il/realestate/item/wgub12o4' });
  assert.equal(getRejection(ad), 'cross-district-suggestion');
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

test('filterRelevantAds drops urban ads and keeps rural matches', () => {
  const accepted = filterRelevantAds([
    makeAd(),
    makeAd({
      title: 'מודעה בעיר',
      rawText: 'מודעה בעיר\nתל אביב\n5 חדרים\n8,000 ₪',
      locationText: 'תל אביב',
      city: 'תל אביב',
      descriptionText: 'דירה במרכז העיר'
    })
  ]);

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].locationText, 'בת חפר');
});
