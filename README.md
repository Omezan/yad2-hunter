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
- `lev-hapark-rent` / `lev-hapark-sale` — שכונת לב הפארק, רעננה (5+ חדרים), שכירות ומכירה. החיפושים האלה לא שולחים ל-Telegram אלא ל-email לפי `notifyVia: 'email'`, ומופיעים בדאשבורד תחת `/lev-hapark`.
- `rent-in-cities` — שכירות עד ₪9,000, 4+ חדרים, על פני 5 ערים במרכז ובשרון (multiCity). דירה / פנטהאוז / דופלקס בלבד. החיפוש הזה ממשיך לשלוח ל-Telegram (אין `notifyVia`), אבל מוחרג מה-health-check (`excludeFromHealthCheck: true`) ולכן ה-scan עושה לו self-prune שקט בדיוק כמו לב הפארק. הוא מופיע בדאשבורד תחת `/rent-in-cities` ולא בדף הראשי.

ה-URLs עצמם מוגדרים ב-`src/config/searches.js`.

## הגדרה ראשונית (פעם אחת)

1. ב־GitHub: `Settings` → `Secrets and variables` → `Actions` → `New repository secret`. להוסיף שני סודות:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
2. אם רוצים גם להפעיל את ה-watch של לב הפארק (email), להוסיף גם:
   - `SMTP_HOST` — לדוגמה `smtp.gmail.com`
   - `SMTP_PORT` — לדוגמה `465`
   - `SMTP_SECURE` — `true` עבור 465, `false` עבור 587
   - `SMTP_USER` — שם המשתמש (כתובת המייל ששולחת)
   - `SMTP_PASS` — App Password (לא הסיסמה הרגילה של Google)
   - `SMTP_FROM` — `"Yad2 Hunter <you@example.com>"`
   - `EMAIL_RECIPIENTS` — נמען / רשימה מופרדת בפסיקים (ברירת מחדל בקוד: `ohadmezan@gmail.com`)
3. ב־`Settings` → `Actions` → `General` → `Workflow permissions` לוודא שמסומן `Read and write permissions`.
4. אחרי שהקוד נדחף, להיכנס ל-`Actions` → `Yad2 Scan` → `Run workflow` כדי להפעיל ידנית פעם ראשונה. מהריצה הבאה והלאה הוא ירוץ אוטומטית כל 5 דקות.

## מה קורה בריצה הראשונה

בריצה הראשונה כל המודעות שעולות בחיפושים נחשבות חדשות. תקבל הודעה אחת ארוכה עם כל הרשימה. מהריצה השנייה והלאה תקבל הודעה רק כשבאמת יש מודעה חדשה.

## משתני סביבה (אופציונליים)

מעבר לסודות, אפשר להגדיר ב-`.env` או ב־workflow:

- `TELEGRAM_NOTIFICATIONS_ENABLED` — ברירת מחדל `true`.
- `EMAIL_NOTIFICATIONS_ENABLED` — ברירת מחדל `true`. אם חסר אחד מה-`SMTP_*` השירות מדלג בלי שגיאה.
- `PLAYWRIGHT_HEADLESS` — ברירת מחדל `true`.
- `SEARCH_TIMEOUT_MS` — ברירת מחדל `60000`.
- `ENABLED_SEARCH_IDS` — לסינון לקבוצת חיפושים מסוימת (למשל `center-sharon,south`, `lev-hapark-rent,lev-hapark-sale`, או `rent-in-cities`).
- `HISTORY_LIMIT` — כמה ריצות לזכור ב-`runs.json`. ברירת מחדל `50`.
- `SEEN_RETENTION_DAYS` — לכמה ימים לשמור מודעה ב-`seen-ads.json`. ברירת מחדל `30`.

### Lev HaPark email watch

- בדאשבורד יש דף נפרד `/lev-hapark` עם כפתור "הרץ סריקה" ייעודי שמפעיל רק את שני החיפושים האלה.
- כשהריצה מוצאת מודעות חדשות בלב הפארק היא שולחת מייל ל-`EMAIL_RECIPIENTS` (במקום Telegram). חמשת ה-`SMTP_*` ו-`EMAIL_RECIPIENTS` צריכים להיות מוגדרים כסודות ב-GitHub Actions וגם בקובץ `.env` המקומי.
- אם רוצים לבטל זמנית, להגדיר `EMAIL_NOTIFICATIONS_ENABLED=false`. המודעות עדיין יישמרו ב-`seen-ads.json` ויופיעו בדאשבורד.

### Rent-in-cities Telegram watch

- בדאשבורד יש דף נפרד `/rent-in-cities` עם כפתור "הרץ סריקה" ייעודי שמפעיל רק את ה-watch הזה.
- ההתראות נשלחות ל-Telegram (אותו `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` של המושבים) — אין שום סוד נוסף שצריך להגדיר.
- ה-watch מוחרג מה-health-check (`excludeFromHealthCheck: true`), ולכן כשמודעה נמחקת מ-Yad2 — ה-scan הרגיל מנקה אותה בשקט מ-`seen-ads.json` בלי לשלוח התראה. כלל הסריקות במושבים והדף הראשי לא מושפעים כלל.
- לא מופיע בדף הראשי (`/`) — רק בדף הייעודי.
- בנוסף ל-self-prune של ה-scan, יש workflow ייעודי `Yad2 Silent Prune (rent-in-cities)` שרץ פעם ביום ב-21:00 UTC (≈00:00 שעון ישראל) ועושה probe ספציפי לכל מודעת `rent-in-cities` שקיימת ב-`seen-ads.json`. רק מודעה שמחזירה 404 / "הוסרה" נמחקת. blocked / error / live נשמרים. אין שום התראה ואין רישום ב-`runs.json`, ולכן הפעולה לא משפיעה על הפילים של הדאשבורד הראשי.

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
