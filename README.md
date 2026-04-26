# Yad2 Hunter

MVP מינימלי שסורק את Yad2 כל 5 דקות, מזהה מודעות חדשות בלבד, ושולח הודעת Telegram אחת מרוכזת עם כל המודעות החדשות שנמצאו.

## מה כלול

- סקרייפר Playwright לכמה חיפושי שכירות ב-Yad2.
- סינון רלוונטיות בסיסי.
- שמירת `seen_ads` ו-`runs` ב-Postgres כדי למנוע כפילויות.
- הודעת Telegram אחת לכל ריצה שיש בה מודעות חדשות.
- `render.yaml` לפריסה כ-cron job בלבד על Render.

## החיפושים שנסרקים

- `center-and-sharon`
- `south`
- `coastal-north`
- `north-and-valleys`
- `jerusalem-area`

ה-URLs עצמם מוגדרים ב-`src/config/searches.js`.

## משתני סביבה

העתק את `.env.example` ל-`.env` והגדר:

- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

אופציונלי:

- `PLAYWRIGHT_HEADLESS`
- `SEARCH_TIMEOUT_MS`
- `ENABLED_SEARCH_IDS`

## הרצה מקומית

ודא שיש לך Postgres זמין ומלא `.env`, ואז:

```bash
npm run scan
```

לבדיקת Telegram בלבד:

```bash
npm run telegram:test
```

לבדיקת scraping בלי DB ובלי Telegram:

```bash
npm run scrape:dry-run
```

## פריסה ב-Render

הפרויקט כולל:

- `Dockerfile` שמריץ worker יחיד.
- `render.yaml` שמגדיר:
  - Postgres מנוהל
  - Cron job כל 5 דקות

אחרי יצירת השירותים מ-`render.yaml`, מלא ב-Render את:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## התנהגות ההודעות

- אם אין מודעות חדשות: לא נשלחת הודעה.
- אם יש מודעות חדשות: נשלחת הודעה אחת מרוכזת עם כותרות ולינקים לכל המודעות החדשות.

## אבטחה

טוקן טלגרם חייב להישמר רק ב-env. אם טוקן נחשף בעבר, מומלץ לסובב אותו דרך BotFather לפני פריסה.
