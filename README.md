# Yad2 Hunter

MVP מינימלי שסורק את Yad2 כל 5 דקות, מזהה מודעות חדשות, ושולח הודעת Telegram אחת מרוכזת עם כל המודעות החדשות שנמצאו. רץ כולו על GitHub Actions, בלי שרת ובלי DB.

## איך זה עובד

1. GitHub Action מתוזמן רץ כל 5 דקות (`*/5 * * * *`).
2. ה־Action משחזר את קובץ ה־state האחרון מהענף `state` של אותו ריפו.
3. Playwright Chromium סורק את החיפושים שמוגדרים ב-`src/config/searches.js`.
4. המודעות עוברות פילטר רלוונטיות בסיסי.
5. כל מודעה שלא נראתה לפני כן נחשבת חדשה ומתווספת ל-`state/seen-ads.json`.
6. אם יש מודעות חדשות, נשלחת הודעת Telegram אחת מרוכזת עם כל הקישורים.
7. ה־Action דוחף בחזרה לענף `state` את הקבצים המעודכנים.

## החיפושים שנסרקים

- `center-and-sharon`
- `south`
- `coastal-north`
- `north-and-valleys`
- `jerusalem-area`

ה-URLs עצמם מוגדרים ב-`src/config/searches.js`.

## הגדרה ראשונית (פעם אחת)

1. ב־GitHub: `Settings` → `Secrets and variables` → `Actions` → `New repository secret`. להוסיף שני סודות:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
2. ב־`Settings` → `Actions` → `General` → `Workflow permissions` לוודא שמסומן `Read and write permissions`.
3. אחרי שהקוד נדחף, להיכנס ל-`Actions` → `Yad2 Scan` → `Run workflow` כדי להפעיל ידנית פעם ראשונה. מהריצה הבאה והלאה הוא ירוץ אוטומטית כל 5 דקות.

## מה קורה בריצה הראשונה

בריצה הראשונה כל המודעות שעולות בחיפושים נחשבות חדשות. תקבל הודעה אחת ארוכה עם כל הרשימה. מהריצה השנייה והלאה תקבל הודעה רק כשבאמת יש מודעה חדשה.

## משתני סביבה (אופציונליים)

מעבר לסודות, אפשר להגדיר ב-`.env` או ב־workflow:

- `TELEGRAM_NOTIFICATIONS_ENABLED` — ברירת מחדל `true`.
- `PLAYWRIGHT_HEADLESS` — ברירת מחדל `true`.
- `SEARCH_TIMEOUT_MS` — ברירת מחדל `60000`.
- `ENABLED_SEARCH_IDS` — לסינון לקבוצת חיפושים מסוימת (למשל `center-sharon,south`).
- `HISTORY_LIMIT` — כמה ריצות לזכור ב-`runs.json`. ברירת מחדל `50`.
- `SEEN_RETENTION_DAYS` — לכמה ימים לשמור מודעה ב-`seen-ads.json`. ברירת מחדל `30`.

## הרצה מקומית (אופציונלי)

```bash
cp .env.example .env
# ערוך .env עם הטוקן של הבוט ו-CHAT_ID
npm install
npx playwright install chromium
npm run scan
```

לבדיקת Telegram בלבד (דורש רשת לא חוסמת):

```bash
npm run telegram:test
```

לבדיקת scraping בלי DB ובלי Telegram:

```bash
npm run scrape:dry-run
```

## אבטחה

הטוקן של הבוט חייב להישמר רק ב-Secrets של GitHub. אם טוקן נחשף בעבר, מומלץ לסובב אותו דרך BotFather (`/revoke`) ולעדכן את ה-Secret.
