const axios = require('axios');
const https = require('https');

const TELEGRAM_TOKEN = '8704311778:AAGD31V8niD78BW2KZ0_OzXbtIuSeOz0KeU';
const CHAT_ID = '486287404';

const agent = new https.Agent({
  rejectUnauthorized: false
});

async function sendMessage() {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: '🚀 זה עובד! מצאנו דירה בקרוב 😉'
      },
      { httpsAgent: agent }
    );

    console.log(res.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
  }
}

sendMessage();