# Yad2 Hunter

כלי שסורק את Yad2 כל 5 דקות, שומר היסטוריית עדכונים ב-Postgres, ושולח הודעת Telegram אחת עם לינק לעמוד שמציג את כל המודעות החדשות של אותה ריצה.

## מה כלול

- סקרייפר Playwright ל-Yad2 עם חיפוש לפי כמה אזורים.
- מנגנון dedup שמזהה מודעות חדשות בלבד.
- דשבורד Express עם:
  - היסטוריית ריצות
  - עמוד ייעודי לכל עדכון
  - פילטרים בסיסיים כמו מחוז, מחיר, חדרים וטקסט חופשי
- שליחת Telegram מרוכזת עם לינק אחד לכל batch חדש.
- קבצי Docker + `render.yaml` לפריסה כ-Web + Cron על Render.

## משתני סביבה

העתק את `.env.example` ל-`.env` והגדר:

- `DATABASE_URL`
- `APP_BASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## הרצה מקומית

1. ודא שיש לך Postgres זמין.
2. מלא `.env`.
3. הרץ:

```bash
npm start
```

הדשבורד יעלה ב-`http://localhost:3000`.

להרצת סריקה חד-פעמית:

```bash
npm run scan
```

להפעלת cron מקומי מתוך ה-web process:

```bash
ENABLE_LOCAL_CRON=true npm start
```

לבדיקת Telegram:

```bash
npm run telegram:test
```

## פריסה ב-Render

הפרויקט כולל:

- `Dockerfile` עם Playwright Chromium.
- `render.yaml` שמגדיר:
  - Web service עבור הדשבורד
  - Cron job כל 5 דקות
  - Postgres מנוהל

אחרי יצירת השירותים מ-`render.yaml`, מלא ב-Render את:

- `APP_BASE_URL` עם ה-URL הציבורי של ה-web service
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## אבטחה

הטוקן שהיה hardcoded הוסר מהקוד. עדיין מומלץ לסובב את הטוקן בפועל דרך BotFather, כי הוא נחשף קודם לכן.
