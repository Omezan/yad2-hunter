const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterRelevantAds,
  getRejection,
  isRelevant
} = require('../src/services/relevance');
const { formatDigestMessage } = require('../src/services/telegram');
const { extractExternalId, normalizeItemUrl } = require('../src/scraper/yad2');

const ITEM = 'https://www.yad2.co.il/realestate/item/abc123';

function makeAd(overrides) {
  return {
    title: 'דירה למשפחה',
    rawText: 'דירה למשפחה\nקיבוץ דוגמה\n4 חדרים\n8,500 ₪',
    locationText: 'קיבוץ דוגמה',
    searchLabel: 'מרכז ושרון',
    link: ITEM,
    price: 8500,
    rooms: 4,
    ...overrides
  };
}

test('normalizeItemUrl strips query params and trailing slash', () => {
  assert.equal(
    normalizeItemUrl('https://www.yad2.co.il/realestate/item/abc123/?foo=bar'),
    'https://www.yad2.co.il/realestate/item/abc123'
  );
});

test('extractExternalId returns the Yad2 item id', () => {
  assert.equal(
    extractExternalId('https://www.yad2.co.il/realestate/item/abc123?foo=bar'),
    'abc123'
  );
});

test('isRelevant accepts ads in a kibbutz with valid rooms and price', () => {
  assert.equal(isRelevant(makeAd()), true);
});

test('isRelevant rejects non-item URLs', () => {
  const ad = makeAd({ link: 'https://www.yad2.co.il/commercial-projects/abc' });
  assert.equal(getRejection(ad), 'non-item-url');
});

test('isRelevant rejects ads without a rural marker', () => {
  const ad = makeAd({
    rawText: 'דירה מרווחת\nתל אביב\n4 חדרים\n8,500 ₪',
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

test('isRelevant rejects ads above the max price', () => {
  const ad = makeAd({ price: 12000 });
  assert.equal(getRejection(ad), 'price:12000');
});

test('isRelevant rejects ads below the minimum rooms', () => {
  const ad = makeAd({ rooms: 3 });
  assert.equal(getRejection(ad), 'rooms:3');
});

test('isRelevant rejects ads when no rural marker is present', () => {
  const ad = makeAd({
    rawText: 'דירה יפה\nשכונה חדשה\n4 חדרים\n8,500 ₪',
    locationText: 'שכונה חדשה'
  });
  assert.equal(getRejection(ad), 'no-rural-marker');
});

test('filterRelevantAds keeps only the rural matching ads', () => {
  const accepted = filterRelevantAds([
    makeAd(),
    makeAd({
      title: 'מודעה בעיר',
      rawText: 'מודעה בעיר\nתל אביב\n5 חדרים\n8,000 ₪',
      locationText: 'תל אביב'
    }),
    makeAd({
      title: 'מודעה בקיבוץ אחר',
      rawText: 'מודעה בקיבוץ אחר\nמושב יוגב\n4 חדרים\n8,800 ₪',
      locationText: 'מושב יוגב'
    })
  ]);

  assert.equal(accepted.length, 2);
});

test('formatDigestMessage creates one digest with the full link list', () => {
  const message = formatDigestMessage({
    newAds: [
      { title: 'בית ראשון', districtLabel: 'מרכז והשרון', link: 'https://www.yad2.co.il/realestate/item/1' },
      { title: 'בית שני', districtLabel: 'דרום', link: 'https://www.yad2.co.il/realestate/item/2' },
      { title: 'בית שלישי', districtLabel: 'דרום', link: 'https://www.yad2.co.il/realestate/item/3' },
      { title: 'בית רביעי', districtLabel: 'ירושלים והסביבה', link: 'https://www.yad2.co.il/realestate/item/4' }
    ]
  });

  assert.match(message, /נמצאו 4 מודעות חדשות/);
  assert.match(message, /מרכז והשרון, דרום, ירושלים והסביבה/);
  assert.match(message, /www\.yad2\.co\.il\/realestate\/item\/1/);
  assert.match(message, /www\.yad2\.co\.il\/realestate\/item\/4/);
});
