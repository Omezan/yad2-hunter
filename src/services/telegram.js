const axios = require('axios');
const { env } = require('../config/env');

function truncateTitle(title, maxLength = 70) {
  if (!title || title.length <= maxLength) {
    return title;
  }

  return `${title.slice(0, maxLength - 1)}…`;
}

function formatAdLine(ad, index) {
  return `${index + 1}. ${truncateTitle(ad.title)}\n${ad.link}`;
}

function formatDigestMessage({ newAds }) {
  const districtSummary = Array.from(
    new Set(newAds.map((ad) => ad.districtLabel).filter(Boolean))
  ).join(', ');

  const adLines = newAds.map(formatAdLine).join('\n\n');

  return [
    `🏠 נמצאו ${newAds.length} מודעות חדשות ב-Yad2`,
    districtSummary ? `אזורים: ${districtSummary}` : null,
    `\n${adLines}`
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

async function sendNewAdsDigest({ newAds }) {
  const message = formatDigestMessage({ newAds });
  return sendTelegramMessage(message);
}

module.exports = {
  formatDigestMessage,
  sendNewAdsDigest,
  sendTelegramMessage
};
