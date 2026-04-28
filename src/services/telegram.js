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

async function sendTelegramMessage(input) {
  const {
    text,
    parseMode,
    disablePreview = false
  } = typeof input === 'string' ? { text: input } : input || {};

  if (!env.TELEGRAM_NOTIFICATIONS_ENABLED) {
    return { skipped: true, reason: 'Telegram notifications are disabled' };
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { skipped: true, reason: 'Missing Telegram credentials' };
  }

  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: disablePreview
  };
  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  const response = await axios.post(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    payload
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

function padCell(value, width) {
  const str = String(value);
  const visible = Array.from(str).length;
  if (visible >= width) return str;
  return str + ' '.repeat(width - visible);
}

function formatHealthCheckMessage({ rows, allMatch, generatedAt }) {
  const headerLabel = '🩺 בדיקה יומית של Yad2 Hunter';
  const statusLine = allMatch
    ? '✅ הכל תקין — Real תואם ל-Expected בכל האזורים'
    : '⚠️ נמצאו פערים — Real לא תואם ל-Expected';

  const labels = ['District', ...rows.map((r) => r.label)];
  const realCells = ['Real', ...rows.map((r) => formatRealCell(r))];
  const expectedCells = ['Expected', ...rows.map((r) => formatExpectedCell(r))];

  const labelWidth = Math.max(...labels.map((v) => Array.from(v).length));
  const realWidth = Math.max(...realCells.map((v) => Array.from(v).length));
  const expectedWidth = Math.max(...expectedCells.map((v) => Array.from(v).length));

  const lines = [];
  lines.push(
    `${padCell(labels[0], labelWidth)}  ${padCell(realCells[0], realWidth)}  ${padCell(
      expectedCells[0],
      expectedWidth
    )}`
  );

  for (let i = 0; i < rows.length; i += 1) {
    lines.push(
      `${padCell(labels[i + 1], labelWidth)}  ${padCell(
        realCells[i + 1],
        realWidth
      )}  ${padCell(expectedCells[i + 1], expectedWidth)}`
    );
  }

  const totalReal = rows.reduce((sum, r) => sum + (r.real ?? 0), 0);
  const totalExpected = rows.reduce((sum, r) => sum + (r.expected ?? 0), 0);

  lines.push(
    `${padCell('Total', labelWidth)}  ${padCell(String(totalReal), realWidth)}  ${padCell(
      String(totalExpected),
      expectedWidth
    )}`
  );

  const timestamp = generatedAt
    ? new Date(generatedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
    : null;
  const footer = timestamp ? `\nנבדק: ${timestamp}` : '';

  return `${headerLabel}\n${statusLine}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`${footer}`;
}

function formatRealCell(row) {
  if (row.error) return 'ERR';
  if (row.real === null || row.real === undefined) return '?';
  return String(row.real);
}

function formatExpectedCell(row) {
  if (row.expected === null || row.expected === undefined) return '?';
  if (row.error || row.real === null || row.real === undefined) {
    return String(row.expected);
  }
  if (row.real === row.expected) return `${row.expected} ✓`;
  const delta = row.real - row.expected;
  const sign = delta > 0 ? '+' : '';
  return `${row.expected} (${sign}${delta})`;
}

async function sendHealthCheckReport({ rows, allMatch, generatedAt }) {
  const text = formatHealthCheckMessage({ rows, allMatch, generatedAt });
  const result = await sendTelegramMessage({
    text,
    parseMode: 'Markdown',
    disablePreview: true
  });
  return { text, result };
}

module.exports = {
  formatDigestMessage,
  formatDigestMessages,
  formatHealthCheckMessage,
  sendHealthCheckReport,
  sendNewAdsDigest,
  sendTelegramMessage
};
