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

function buildDashboardFooter({ runStartedAt } = {}) {
  const baseUrl = (env.DASHBOARD_URL || '').trim();
  if (!baseUrl) return null;

  let url = baseUrl;
  if (runStartedAt) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    url = `${baseUrl}${separator}since=${encodeURIComponent(runStartedAt)}`;
  }
  return `לוח בקרה: ${url}`;
}

function formatDigestMessages({ newAds, runStartedAt } = {}) {
  if (!newAds || !newAds.length) return [];

  const districtSummary = Array.from(
    new Set(newAds.map((ad) => ad.districtLabel).filter(Boolean))
  ).join(', ');

  const chunks = buildChunks({ newAds, districtSummary });
  const totalParts = chunks.length;
  const footer = buildDashboardFooter({ runStartedAt });

  return chunks.map((chunkLines, index) => {
    const header = buildHeader({
      totalAds: newAds.length,
      districtSummary,
      partIndex: index + 1,
      totalParts
    });
    const isLastPart = index === totalParts - 1;
    const body = chunkLines.join('\n\n');
    if (isLastPart && footer) {
      return `${header}\n\n${body}\n\n${footer}`;
    }
    return `${header}\n\n${body}`;
  });
}

function formatDigestMessage({ newAds, runStartedAt } = {}) {
  const messages = formatDigestMessages({ newAds, runStartedAt });
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

async function sendNewAdsDigest({ newAds, runStartedAt } = {}) {
  const messages = formatDigestMessages({ newAds, runStartedAt });
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

const HEALTH_CHECK_DIFF_LIMIT_PER_DISTRICT = 10;

function externalIdToLink(externalId) {
  if (!externalId) return null;
  return `https://www.yad2.co.il/realestate/item/${externalId}`;
}

function formatHealthCheckMessage({ rows, allMatch, generatedAt }) {
  return buildHealthCheckMessages({ rows, allMatch, generatedAt }).join('\n\n');
}

function formatHealthCheckDiffSection(rows) {
  const messages = buildHealthCheckDiffMessages(rows);
  return messages.length ? messages.join('\n\n') : null;
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

function buildHealthCheckMessages({ rows, allMatch, generatedAt }) {
  const summary = formatHealthCheckSummary({ rows, allMatch, generatedAt });
  if (allMatch) {
    return [summary];
  }

  const diffMessages = buildHealthCheckDiffMessages(rows);
  return [summary, ...diffMessages];
}

function formatHealthCheckSummary({ rows, allMatch, generatedAt }) {
  const headerLabel = '🩺 Yad2 Hunter — בדיקת תקינות';
  const statusLine = allMatch
    ? '✅ הכל תקין — Real תואם ל-Expected בכל האזורים'
    : '⚠️ נמצאו פערים — Real לא תואם ל-Expected';

  const labels = ['District', ...rows.map((r) => r.label)];
  const realCells = ['Real', ...rows.map((r) => formatRealCell(r))];
  const expectedCells = ['Expected', ...rows.map((r) => formatExpectedCell(r))];

  const labelWidth = Math.max(...labels.map((v) => Array.from(v).length));
  const realWidth = Math.max(...realCells.map((v) => Array.from(v).length));
  const expectedWidth = Math.max(...expectedCells.map((v) => Array.from(v).length));

  const tableLines = [];
  tableLines.push(
    `${padCell(labels[0], labelWidth)}  ${padCell(realCells[0], realWidth)}  ${padCell(
      expectedCells[0],
      expectedWidth
    )}`
  );

  for (let i = 0; i < rows.length; i += 1) {
    tableLines.push(
      `${padCell(labels[i + 1], labelWidth)}  ${padCell(
        realCells[i + 1],
        realWidth
      )}  ${padCell(expectedCells[i + 1], expectedWidth)}`
    );
  }

  const totalReal = rows.reduce((sum, r) => sum + (r.real ?? 0), 0);
  const totalExpected = rows.reduce((sum, r) => sum + (r.expected ?? 0), 0);

  tableLines.push(
    `${padCell('Total', labelWidth)}  ${padCell(String(totalReal), realWidth)}  ${padCell(
      String(totalExpected),
      expectedWidth
    )}`
  );

  const timestamp = generatedAt
    ? new Date(generatedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
    : null;
  const footerLines = [];
  if (timestamp) {
    footerLines.push(`נבדק: ${timestamp}`);
  }
  const dashboard = (env.DASHBOARD_URL || '').trim();
  if (dashboard) {
    footerLines.push(`לוח בקרה: ${dashboard}`);
  }
  const footer = footerLines.length ? `\n${footerLines.join('\n')}` : '';

  return `${headerLabel}\n${statusLine}\n\n\`\`\`\n${tableLines.join('\n')}\n\`\`\`${footer}`;
}

function buildHealthCheckDiffMessages(rows) {
  const blocks = [];
  for (const row of rows) {
    const block = formatDiffBlockForRow(row);
    if (block) blocks.push(block);
  }
  if (!blocks.length) return [];

  const messages = [];
  let current = '🔎 פרטי הפערים:';
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (Array.from(candidate).length > 3500) {
      if (current && current !== '🔎 פרטי הפערים:') {
        messages.push(current);
      }
      current = `🔎 פרטי הפערים (המשך):\n\n${block}`;
    } else {
      current = candidate;
    }
  }
  if (current && current !== '🔎 פרטי הפערים:') {
    messages.push(current);
  }
  return messages;
}

function formatDiffBlockForRow(row) {
  const missingIds = Array.isArray(row.missingIds) ? row.missingIds : [];
  const extraIds = Array.isArray(row.extraIds) ? row.extraIds : [];
  if (!missingIds.length && !extraIds.length && !row.error) return null;

  const lines = [`📍 ${row.label}`];
  if (row.error) {
    lines.push(`  שגיאה: ${row.error}`);
  }

  if (missingIds.length) {
    const shown = missingIds.slice(0, HEALTH_CHECK_DIFF_LIMIT_PER_DISTRICT);
    const omitted = missingIds.length - shown.length;
    lines.push(`  חסר ב-seen (${missingIds.length}):`);
    for (const id of shown) {
      const link = externalIdToLink(id);
      lines.push(`    • ${link || id}`);
    }
    if (omitted > 0) {
      lines.push(`    … ועוד ${omitted}`);
    }
  }

  if (extraIds.length) {
    const shown = extraIds.slice(0, HEALTH_CHECK_DIFF_LIMIT_PER_DISTRICT);
    const omitted = extraIds.length - shown.length;
    lines.push(`  ב-seen אך לא ב-Yad2 (${extraIds.length}):`);
    for (const id of shown) {
      const link = externalIdToLink(id);
      lines.push(`    • ${link || id}`);
    }
    if (omitted > 0) {
      lines.push(`    … ועוד ${omitted}`);
    }
  }

  return lines.join('\n');
}

async function sendHealthCheckReport({ rows, allMatch, generatedAt }) {
  const messages = buildHealthCheckMessages({ rows, allMatch, generatedAt });
  const results = [];
  for (let i = 0; i < messages.length; i += 1) {
    const result = await sendTelegramMessage({
      text: messages[i],
      parseMode: 'Markdown',
      disablePreview: true
    });
    results.push(result);
    if (i < messages.length - 1) {
      await sleep(800);
    }
  }
  return { messages, results };
}

module.exports = {
  formatDigestMessage,
  formatDigestMessages,
  formatHealthCheckDiffSection,
  formatHealthCheckMessage,
  sendHealthCheckReport,
  sendNewAdsDigest,
  sendTelegramMessage
};
