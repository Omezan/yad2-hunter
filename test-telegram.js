const { sendTelegramMessage } = require('./src/services/telegram');

async function sendMessage() {
  try {
    const result = await sendTelegramMessage('בדיקת טלגרם: הבוט מחובר בהצלחה.');
    console.log(result);
  } catch (error) {
    console.error(error.response?.data || error.message);
    process.exitCode = 1;
  }
}

sendMessage();