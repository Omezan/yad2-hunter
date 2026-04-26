const axios = require('axios');
const { env } = require('../config/env');

function truncateTitle(title, maxLength = 70) {
  if (!title || title.length <= maxLength) {
    return title;
  }

  return `${title.slice(0, maxLength - 1)}…`;
}

function formatDigestMessage({ runUrl, newAds }) {
  const districtSummary = Array.from(
    new Set(newAds.map((ad) => ad.districtLabel).filter(Boolean))
  ).join(', ');

  const preview = newAds
    .slice(0, 3)
    .map((ad) => `- ${truncateTitle(ad.title)}`)
    .join('\n');

  const extraCount = newAds.length > 3 ? `\nועוד ${newAds.length - 3} מודעות חדשות.` : '';

  return [
    `🏠 נמצאו ${newAds.length} מודעות חדשות ב-Yad2`,
    districtSummary ? `אזורים: ${districtSummary}` : null,
    preview ? `\nדוגמיות:\n${preview}${extraCount}` : null,
    `\nלצפייה בכל המודעות החדשות:\n${runUrl}`
  ]
    .filter(Boolean)
    .join('\n');
}

async function sendTelegramMessage(text) {
  if (!env.TELEGRAM_NOTIFICATIONS_ENABLED) {
    return { skipped: true, reason: 'Telegram notifications are disabled' };
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { skipped: true, reason: 'Missing Telegram credentials' };
  }

  const response = await axios.post(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false
    }
  );

  return response.data;
}

async function sendNewAdsDigest({ runId, newAds, runUrl }) {
  const message = formatDigestMessage({ runId, newAds, runUrl });
  return sendTelegramMessage(message);
}

module.exports = {
  formatDigestMessage,
  sendNewAdsDigest,
  sendTelegramMessage
};
