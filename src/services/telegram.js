const axios = require('axios');
const { env } = require('../config/env');

function truncateTitle(title, maxLength = 70) {
  if (!title || title.length <= maxLength) {
    return title;
  }

  return `${title.slice(0, maxLength - 1)}…`;
}

function formatPrice(price, hasExplicitPrice) {
  if (typeof price === 'number' && hasExplicitPrice !== false) {
    return `${price.toLocaleString('he-IL')} ₪`;
  }
  return 'מחיר לא מצוין';
}

function formatRooms(rooms) {
  if (typeof rooms !== 'number') return null;
  const display = Number.isInteger(rooms) ? rooms.toString() : rooms.toFixed(1);
  return `${display} חדרים`;
}

function formatPublished(ad) {
  if (!ad.publishedAt) return null;
  const [year, month, day] = ad.publishedAt.split('-');
  if (!year || !month || !day) return null;
  return `פורסם ${day}/${month}/${year.slice(-2)}`;
}

function formatAdLine(ad, index) {
  const heading = truncateTitle(ad.title || 'מודעה');
  const facts = [
    formatRooms(ad.rooms),
    formatPrice(ad.price, ad.hasExplicitPrice),
    formatPublished(ad)
  ]
    .filter(Boolean)
    .join(' · ');
  const factsLine = facts ? `\n${facts}` : '';
  return `${index + 1}. ${heading}${factsLine}\n${ad.link}`;
}

const TELEGRAM_MAX_CHARS = 4000;

function buildHeader({ totalAds, districtSummary, partIndex, totalParts }) {
  const lines = [`🏠 נמצאו ${totalAds} מודעות חדשות ב-Yad2`];
  if (districtSummary) {
    lines.push(`אזורים: ${districtSummary}`);
  }
  if (totalParts > 1) {
    lines.push(`חלק ${partIndex} מתוך ${totalParts}`);
  }
  return lines.join('\n');
}

function buildChunks({ newAds, districtSummary }) {
  const lines = newAds.map(formatAdLine);
  const chunks = [];
  let current = [];
  let currentLength = 0;
  const headerOverhead = buildHeader({
    totalAds: newAds.length,
    districtSummary,
    partIndex: 99,
    totalParts: 99
  }).length + 2;

  for (const line of lines) {
    const lineLength = line.length + 2;
    if (current.length && currentLength + lineLength + headerOverhead > TELEGRAM_MAX_CHARS) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += lineLength;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

function formatDigestMessages({ newAds }) {
  if (!newAds.length) return [];

  const districtSummary = Array.from(
    new Set(newAds.map((ad) => ad.districtLabel).filter(Boolean))
  ).join(', ');

  const chunks = buildChunks({ newAds, districtSummary });
  const totalParts = chunks.length;

  return chunks.map((chunkLines, index) => {
    const header = buildHeader({
      totalAds: newAds.length,
      districtSummary,
      partIndex: index + 1,
      totalParts
    });
    return `${header}\n\n${chunkLines.join('\n\n')}`;
  });
}

function formatDigestMessage({ newAds }) {
  const messages = formatDigestMessages({ newAds });
  return messages[0] || '';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendNewAdsDigest({ newAds }) {
  const messages = formatDigestMessages({ newAds });
  if (!messages.length) {
    return { skipped: true, reason: 'No new ads' };
  }

  const results = [];
  for (let i = 0; i < messages.length; i += 1) {
    const result = await sendTelegramMessage(messages[i]);
    results.push(result);
    if (i < messages.length - 1) {
      await sleep(800);
    }
  }

  return {
    parts: results.length,
    results
  };
}

module.exports = {
  formatDigestMessage,
  formatDigestMessages,
  sendNewAdsDigest,
  sendTelegramMessage
};
