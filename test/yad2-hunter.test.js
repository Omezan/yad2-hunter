const test = require('node:test');
const assert = require('node:assert/strict');

const { filterRelevantAds } = require('../src/services/relevance');
const { formatDigestMessage } = require('../src/services/telegram');
const { extractExternalId, normalizeItemUrl } = require('../src/scraper/yad2');

test('normalizeItemUrl strips query params and trailing slash', () => {
  assert.equal(
    normalizeItemUrl('https://www.yad2.co.il/item/abc123/?foo=bar'),
    'https://www.yad2.co.il/item/abc123'
  );
});

test('extractExternalId returns the Yad2 item id', () => {
  assert.equal(
    extractExternalId('https://www.yad2.co.il/item/abc123?foo=bar'),
    'abc123'
  );
});

test('filterRelevantAds excludes ads with blocked keywords', () => {
  const relevantAds = filterRelevantAds([
    { title: 'בית פרטי', rawText: 'דירה מרווחת', locationText: '', searchLabel: '' },
    { title: 'שותפים לדירה', rawText: 'כולל חניה', locationText: '', searchLabel: '' },
    { title: 'דירת מרתף', rawText: 'שקטה', locationText: '', searchLabel: '' }
  ]);

  assert.equal(relevantAds.length, 1);
  assert.equal(relevantAds[0].title, 'בית פרטי');
});

test('formatDigestMessage creates one digest with the run link', () => {
  const message = formatDigestMessage({
    runUrl: 'https://hunter.example.com/runs/42',
    newAds: [
      { title: 'בית ראשון', districtLabel: 'מרכז והשרון' },
      { title: 'בית שני', districtLabel: 'דרום' },
      { title: 'בית שלישי', districtLabel: 'דרום' },
      { title: 'בית רביעי', districtLabel: 'ירושלים והסביבה' }
    ]
  });

  assert.match(message, /נמצאו 4 מודעות חדשות/);
  assert.match(message, /מרכז והשרון, דרום, ירושלים והסביבה/);
  assert.match(message, /hunter\.example\.com\/runs\/42/);
});
