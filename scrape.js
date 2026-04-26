const { chromium } = require('playwright');

// 🔴 פרטים שלך
const TELEGRAM_TOKEN = '8704311778:AAGD31V8niD78BW2KZ0_OzXbtIuSeOz0KeU';
const CHAT_ID = '486287404';

// 🔍 לינקים
const SEARCH_URLS = [
  'https://www.yad2.co.il/realestate/rent/center-and-sharon?maxPrice=9000&minRooms=4&settlements=1&zoom=9',
  'https://www.yad2.co.il/realestate/rent/south?maxPrice=9000&minRooms=4&settlements=1&zoom=9',
  'https://www.yad2.co.il/realestate/rent/coastal-north?maxPrice=9000&minRooms=4&settlements=1&zoom=9',
  'https://www.yad2.co.il/realestate/rent/north-and-valleys?maxPrice=9000&minRooms=4&settlements=1&zoom=9',
  'https://yad2.co.il/realestate/rent/jerusalem-area?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
];

// 🧠 סינון
function isRelevant(ad) {
  const text = ad.text.toLowerCase();

  if (text.includes('שותפים')) return false;
  if (text.includes('מרתף')) return false;

  return true;
}

// 📩 שליחה לטלגרם דרך הדפדפן
async function sendTelegram(page, message) {
  const encoded = encodeURIComponent(message);
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encoded}`;

  try {
    await page.goto(url);
    console.log('Sent ✔️');
  } catch (err) {
    console.error('Send failed:', err.message);
  }
}

async function scrapeFromUrl(page, url) {
  console.log('Checking:', url);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const ads = await page.$$eval('a[href*="/item/"]', items =>
    items.map(item => ({
      text: item.innerText,
      link: item.href
    }))
  );

  return ads;
}

async function run() {
  const browser = await chromium.launch({ headless: false });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();

  let allAds = [];

  for (const url of SEARCH_URLS) {
    const ads = await scrapeFromUrl(page, url);
    allAds = allAds.concat(ads);
  }

  console.log(`\nTotal ads found: ${allAds.length}`);

  let sentCount = 0;
  const MAX_MESSAGES = 5;

  for (const ad of allAds) {
    if (sentCount >= MAX_MESSAGES) break;

    if (isRelevant(ad)) {
      const message = `🏠 דירה חדשה!\n\n${ad.text}\n\n${ad.link}`;

      await sendTelegram(page, message);
      sentCount++;

      await page.waitForTimeout(2000);
    }
  }

  console.log(`\nSent ${sentCount} ads`);

  await browser.close();
}

run();