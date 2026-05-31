const axios = require('axios');
const dns = require('dns');
const https = require('https');
const { env } = require('../config/env');

const googleDnsResolver = new dns.Resolver();
googleDnsResolver.setServers(['8.8.8.8', '8.8.4.4']);

function googleDnsLookup(hostname, options, callback) {
  googleDnsResolver.resolve4(hostname, (err, addresses) => {
    if (err) return callback(err);
    callback(null, addresses[0], 4);
  });
}

const telegramHttpsAgent = new https.Agent({ lookup: googleDnsLookup });

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

  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      payload,
      { httpsAgent: telegramHttpsAgent }
    );
    return response.data;
  } catch (err) {
    const reason = err.code || err.message || String(err);
    console.error(`[telegram] failed to send message: ${reason}`);
    return { skipped: true, reason: `send failed: ${reason}` };
  }
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

function formatManualScanNoNewAdsMessage({ runStartedAt } = {}) {
  const lines = [
    '🔍 Yad2 Hunter — סריקה ידנית הסתיימה',
    'לא נמצאו מודעות חדשות מאז ההפעלה.'
  ];
  const footer = buildDashboardFooter({ runStartedAt });
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

async function sendManualScanNoNewAdsNotice({ runStartedAt } = {}) {
  const text = formatManualScanNoNewAdsMessage({ runStartedAt });
  const result = await sendTelegramMessage({ text, disablePreview: true });
  return { parts: 1, results: [result] };
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

function formatHealthCheckMessage({ rows, allMatch, generatedAt, reconciliation } = {}) {
  return buildHealthCheckMessages({
    rows,
    allMatch,
    generatedAt,
    reconciliation
  }).join('\n\n');
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

function buildHealthCheckMessages({ rows, allMatch, generatedAt, reconciliation } = {}) {
  const summary = formatHealthCheckSummary({
    rows,
    allMatch,
    reconciliation
  });
  const footer = formatHealthCheckFooter({ generatedAt });

  // Send diff details whenever any row has either an unresolved diff
  // (extra / missing) OR a reconciled diff (added / removed). Even if
  // we closed the gap automatically, the user wants the actual links
  // so they can manually verify on Yad2.
  const hasAnyDiff = rows.some((row) => {
    const reconciled = row.reconciled || {};
    return Boolean(
      (Array.isArray(reconciled.added) && reconciled.added.length) ||
        (Array.isArray(reconciled.removed) && reconciled.removed.length) ||
        (Array.isArray(reconciled.unresolvedExtra) && reconciled.unresolvedExtra.length) ||
        (Array.isArray(reconciled.unresolvedMissing) && reconciled.unresolvedMissing.length) ||
        (Array.isArray(row.missingIds) && row.missingIds.length) ||
        (Array.isArray(row.extraIds) && row.extraIds.length) ||
        row.error
    );
  });

  // No diff to report → just summary + footer in one message.
  if (!hasAnyDiff) {
    return [appendFooter(summary, footer)];
  }

  const diffMessages = buildHealthCheckDiffMessages(rows);

  // Happy path: everything fits in a single Telegram message. We
  // concatenate summary + diff section + footer (in that order) so
  // the user sees one cohesive report rather than two separate pings.
  if (diffMessages.length === 1) {
    const combined = `${summary}\n\n${diffMessages[0]}`;
    const withFooter = appendFooter(combined, footer);
    if (Array.from(withFooter).length <= TELEGRAM_MAX_CHARS) {
      return [withFooter];
    }
  }

  // Fallback: the diff section was already chunked by
  // buildHealthCheckDiffMessages (because it exceeded ~3500 chars).
  // Keep the historical "summary, then one or more diff chunks"
  // shape, but make sure the footer rides along on the LAST chunk so
  // the user always knows when the report was generated.
  const withFooterOnLast = diffMessages.map((msg, idx) =>
    idx === diffMessages.length - 1 ? appendFooter(msg, footer) : msg
  );
  return [summary, ...withFooterOnLast];
}

function appendFooter(text, footer) {
  if (!footer) return text;
  return `${text}\n\n${footer}`;
}

function formatHealthCheckSummary({ rows, allMatch, reconciliation } = {}) {
  const headerLabel = '🩺 Yad2 Hunter — בדיקת תקינות';
  const statusLine = allMatch
    ? '✅ הכל תקין — Real תואם ל-Expected בכל האזורים'
    : '⚠️ נמצאו פערים — Real לא תואם ל-Expected';
  const reconciliationLine = formatReconciliationLine(reconciliation);

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

  const reconciliationBlock = reconciliationLine ? `\n${reconciliationLine}` : '';

  return `${headerLabel}\n${statusLine}${reconciliationBlock}\n\n\`\`\`\n${tableLines.join('\n')}\n\`\`\``;
}

// The "נבדק: …\nלוח בקרה: …" tail. Lives on its own so the
// unified health-check message can place it at the very bottom,
// after both the summary table and the diff details.
function formatHealthCheckFooter({ generatedAt } = {}) {
  const lines = [];
  const timestamp = generatedAt
    ? new Date(generatedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
    : null;
  if (timestamp) {
    lines.push(`נבדק: ${timestamp}`);
  }
  const dashboard = (env.DASHBOARD_URL || '').trim();
  if (dashboard) {
    lines.push(`לוח בקרה: ${dashboard}`);
  }
  return lines.length ? lines.join('\n') : null;
}

function formatReconciliationLine(reconciliation) {
  if (!reconciliation) return null;
  const additions = (reconciliation.additions || []).length;
  const removals = (reconciliation.removals || []).length;
  const persisted = reconciliation.persisted;

  const parts = [];
  if (additions > 0) parts.push(`נוספו ${additions} מודעות חדשות`);
  if (removals > 0) parts.push(`הוסרו ${removals} מודעות שנעלמו מ-Yad2`);
  if (parts.length === 0) {
    if (
      reconciliation.unresolvedExtras?.length ||
      reconciliation.unresolvedMissing?.length
    ) {
      return '⏳ פערים זוהו אך לא נסגרו אוטומטית — יבדקו שוב בריצה הבאה';
    }
    return null;
  }
  let line = `🔧 תוקן ב-seen: ${parts.join(', ')}`;
  if (persisted && persisted.ok === false) {
    line += ` (אזהרה: לא הצלחנו לשמור: ${persisted.reason || 'unknown'})`;
  }
  return line;
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
  const reconciled = row.reconciled || {};
  const added = Array.isArray(reconciled.added) ? reconciled.added : [];
  const removed = Array.isArray(reconciled.removed) ? reconciled.removed : [];
  const unresolvedExtra = Array.isArray(reconciled.unresolvedExtra)
    ? reconciled.unresolvedExtra
    : [];
  const unresolvedMissing = Array.isArray(reconciled.unresolvedMissing)
    ? reconciled.unresolvedMissing
    : [];
  // Backwards compatibility: if a caller still passes the old shape we
  // treat raw extra/missing arrays as "unresolved".
  const fallbackMissing = Array.isArray(row.missingIds) ? row.missingIds : [];
  const fallbackExtra = Array.isArray(row.extraIds) ? row.extraIds : [];

  const hasAnyDelta =
    added.length ||
    removed.length ||
    unresolvedExtra.length ||
    unresolvedMissing.length ||
    fallbackMissing.length ||
    fallbackExtra.length ||
    row.error;
  if (!hasAnyDelta) return null;

  const lines = [`📍 ${row.label}`];
  if (row.error) {
    lines.push(`  שגיאה: ${row.error}`);
  }

  // Helper: render a "header + bulleted links" sub-block. Reasons are
  // collapsed into the header (e.g. "מודעה הוסרה - 404") instead of
  // appearing as a per-link `סיבה:` row, so the Telegram message stays
  // compact and readable. Caller is responsible for picking a header
  // that already conveys the "why".
  const renderSubBlock = (header, items) => {
    if (!items.length) return;
    const shown = items.slice(0, HEALTH_CHECK_DIFF_LIMIT_PER_DISTRICT);
    const omitted = items.length - shown.length;
    lines.push(`  ${header}`);
    for (const item of shown) {
      lines.push(`    • ${item.link || externalIdToLink(item.externalId)}`);
    }
    if (omitted > 0) lines.push(`    … ועוד ${omitted}`);
  };

  if (removed.length) {
    // All removals come from the URL-probe path (HTTP 404). If that
    // ever changes — e.g. a "filter mismatch" removal — the header
    // still reads fine even if not technically "404".
    renderSubBlock('🗑️ מודעה הוסרה - 404', removed);
  }

  if (added.length) {
    renderSubBlock('✅ מודעות חדשות שטרם נסרקו:', added);
  }

  if (unresolvedMissing.length || (!added.length && fallbackMissing.length)) {
    const list = unresolvedMissing.length
      ? unresolvedMissing
      : fallbackMissing.map((id) => ({ externalId: id, link: externalIdToLink(id) }));
    renderSubBlock(`⏳ חסר ב-seen — ייבדק שוב בריצה הבאה (${list.length}):`, list);
  }

  if (unresolvedExtra.length || (!removed.length && fallbackExtra.length)) {
    const list = unresolvedExtra.length
      ? unresolvedExtra
      : fallbackExtra.map((id) => ({ externalId: id, link: externalIdToLink(id) }));
    renderSubBlock(`⏳ ב-seen אך לא ב-Yad2 — ייבדק שוב בריצה הבאה (${list.length}):`, list);
  }

  return lines.join('\n');
}

// Friendlier rendering for the various failure modes that come out
// of scrapeAllSearches. The scraper hands us either the explicit
// "blocked by anti-bot after all retries" sentinel (after 3 fresh
// browser profile retries) or a raw exception message. Translate
// both into a short Hebrew phrase the user can act on at a glance.
function describeScrapeError(message) {
  const raw = typeof message === 'string' ? message.trim() : '';
  if (!raw) return 'שגיאה לא ידועה';
  if (/blocked by anti-?bot/i.test(raw)) return 'נחסם על ידי הגנת captcha של Yad2';
  if (/captcha/i.test(raw)) return 'נחסם על ידי captcha';
  if (/timeout|timed out/i.test(raw)) return 'תם הזמן הקצוב לסריקה';
  if (/net::ERR/i.test(raw)) return 'שגיאת רשת מול Yad2';
  if (/HTTP\s*5\d{2}/i.test(raw)) return 'Yad2 החזיר שגיאת שרת (5xx)';
  return raw;
}

// Group the scraper's flat error list by searchId. The scraper may
// emit several errors for the same watch (one per retry profile);
// we collapse them so the warning shows one line per blocked watch.
function summarizeScrapeErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) return [];
  const bySearchId = new Map();
  for (const err of errors) {
    if (!err || !err.searchId) continue;
    if (!bySearchId.has(err.searchId)) {
      bySearchId.set(err.searchId, {
        searchId: err.searchId,
        searchLabel: err.searchLabel || err.searchId,
        reasons: new Set()
      });
    }
    const entry = bySearchId.get(err.searchId);
    if (err.searchLabel) entry.searchLabel = err.searchLabel;
    entry.reasons.add(describeScrapeError(err.message));
  }
  return Array.from(bySearchId.values()).map((entry) => ({
    searchId: entry.searchId,
    searchLabel: entry.searchLabel,
    reason: Array.from(entry.reasons).join(' · ')
  }));
}

// Formats the operational "some watches couldn't be scraped this
// iteration" notice. Independent of the new-ads digest by design:
// per the product brief this warning ships as its own Telegram
// message after every iteration where errors exist. No dedupe
// across iterations — signal beats silence.
function formatPartialScrapeWarning({ errors, runStartedAt } = {}) {
  const summary = summarizeScrapeErrors(errors);
  if (!summary.length) return '';
  const lines = ['⚠️ Yad2 Hunter — סריקה חלקית', 'החיפושים הבאים לא נסרקו בהצלחה:'];
  for (const item of summary) {
    lines.push(`• ${item.searchLabel} — ${item.reason}`);
  }
  lines.push('', 'המודעות הקיימות בדאשבורד לא הושפעו — ננסה שוב בריצה הבאה.');
  const footer = buildDashboardFooter({ runStartedAt });
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

async function sendPartialScrapeWarning({ errors, runStartedAt } = {}) {
  const text = formatPartialScrapeWarning({ errors, runStartedAt });
  if (!text) return { skipped: true, reason: 'No scrape errors to report' };
  const result = await sendTelegramMessage({ text, disablePreview: true });
  return { parts: 1, results: [result] };
}

// Note: this file previously exposed `formatScrapeFreezeNotice` and
// `sendScrapeFreezeNotice` (the global "we got blocked twice in a
// row, stopping everything for an hour" message) plus a
// `sendFrozenManualNotice` ("you tried to manually run during a
// freeze"). Both were removed when the cooldown layer was reshaped
// from a global circuit breaker to per-search cooldowns: only the
// individual blocked search is held out, everything else keeps
// scanning, and the existing `sendPartialScrapeWarning` already
// covers the user-facing signal we need.

async function sendHealthCheckReport({ rows, allMatch, generatedAt, reconciliation } = {}) {
  const messages = buildHealthCheckMessages({
    rows,
    allMatch,
    generatedAt,
    reconciliation
  });
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
  buildHealthCheckMessages,
  describeScrapeError,
  formatDigestMessage,
  formatDigestMessages,
  formatHealthCheckDiffSection,
  formatHealthCheckMessage,
  formatManualScanNoNewAdsMessage,
  formatPartialScrapeWarning,
  formatReconciliationLine,
  sendHealthCheckReport,
  sendManualScanNoNewAdsNotice,
  sendNewAdsDigest,
  sendPartialScrapeWarning,
  sendTelegramMessage,
  summarizeScrapeErrors
};
