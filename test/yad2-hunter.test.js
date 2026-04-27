const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterRelevantAds,
  getRejection,
  isRelevant
} = require('../src/services/relevance');
const { formatDigestMessage, formatDigestMessages } = require('../src/services/telegram');
const { extractExternalId, normalizeItemUrl } = require('../src/scraper/yad2');

const ITEM = 'https://www.yad2.co.il/realestate/item/center-and-sharon/abc123';

function makeAd(overrides) {
  return {
    title: 'דירה, בת חפר',
    rawText: 'דירה, בת חפר\n6 חדרים\n7,000 ₪',
    locationText: 'בת חפר',
    searchLabel: 'מרכז ושרון',
    link: ITEM,
    price: 7000,
    rooms: 6,
    settlementsOnly: true,
    hasExplicitPrice: true,
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
    locationText: 'תל אביב'
  });
  assert.equal(getRejection(ad), 'urban-location');
});

test('isRelevant rejects ads with explicit promoted keywords', () => {
  const ad = makeAd({
    title: 'יד ראשונה מקבלן',
    rawText: 'יד ראשונה מקבלן\nקיבוץ דוגמה\n4 חדרים\n8,000 ₪'
  });
  assert.match(getRejection(ad) || '', /^keyword:(יד ראשונה|מקבלן)$/);
});

test('requireExplicitPrice rejects ads without an explicit price', () => {
  const ad = makeAd({ price: null, hasExplicitPrice: false });
  assert.equal(getRejection(ad, { requireExplicitPrice: true }), 'no-price');
});

test('requireExplicitPrice still accepts ads with a numeric price', () => {
  const ad = makeAd();
  assert.equal(getRejection(ad, { requireExplicitPrice: true }), null);
});

test('requireExplicitRooms rejects ads without a numeric room count', () => {
  const ad = makeAd({ rooms: null });
  assert.equal(getRejection(ad, { requireExplicitRooms: true }), 'no-rooms');
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
      locationText: 'תל אביב'
    })
  ]);

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].locationText, 'בת חפר');
});
