const nodemailer = require('nodemailer');
const { env } = require('../config/env');

// Mirrors src/services/telegram.js but emits an HTML email digest.
// Routing decision (which searches notify by email vs Telegram) is
// owned by the worker, so this module only cares about *how* to send.

function truncate(value, maxLength = 70) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildDashboardUrl({ runStartedAt, dashboardPath } = {}) {
  const baseUrl = (env.DASHBOARD_URL || '').trim();
  if (!baseUrl) return null;
  let url = baseUrl;
  if (dashboardPath) {
    // Path joining that keeps any querystring already on baseUrl.
    const [origin, query = ''] = baseUrl.split('?');
    const trimmedOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
    const path = dashboardPath.startsWith('/')
      ? dashboardPath
      : `/${dashboardPath}`;
    url = query ? `${trimmedOrigin}${path}?${query}` : `${trimmedOrigin}${path}`;
  }
  if (runStartedAt) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}since=${encodeURIComponent(runStartedAt)}`;
  }
  return url;
}

function buildSubject({ newAds, label, suffix }) {
  const base = label || 'Yad2 Hunter';
  if (suffix) return `${base} — ${suffix}`;
  if (!newAds || !newAds.length) return `${base} — אין מודעות חדשות`;
  return `${base} — ${newAds.length} מודעות חדשות`;
}

function adRowHtml(ad) {
  const facts = [formatRooms(ad.rooms), formatPrice(ad.price, ad.hasExplicitPrice), formatPublished(ad)]
    .filter(Boolean)
    .join(' · ');
  const heading = escapeHtml(truncate(ad.title || 'מודעה'));
  const city = ad.city ? escapeHtml(ad.city) : '';
  const district = ad.districtLabel ? escapeHtml(ad.districtLabel) : '';
  const headerLine = [heading, city].filter(Boolean).join(' · ');
  const districtLine = district
    ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${district}</div>`
    : '';
  const factsLine = facts
    ? `<div style="font-size:13px;color:#374151;margin-top:4px;">${escapeHtml(facts)}</div>`
    : '';
  const link = ad.link
    ? `<a href="${escapeHtml(
        ad.link
      )}" style="display:inline-block;margin-top:8px;color:#1f49e0;text-decoration:none;font-weight:600;">פתח מודעה ביד2 →</a>`
    : '';
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"
      style="width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px;">
      <tr>
        <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;">
          <div style="font-size:15px;font-weight:700;">${headerLine || 'מודעה'}</div>
          ${districtLine}
          ${factsLine}
          ${link}
        </td>
      </tr>
    </table>`;
}

function buildHtml({ newAds, label, runStartedAt, dashboardPath, fallbackHeadline }) {
  const dashboardUrl = buildDashboardUrl({ runStartedAt, dashboardPath });
  const headline =
    newAds && newAds.length > 0
      ? `🏡 ${escapeHtml(label || 'Yad2 Hunter')} — ${newAds.length} מודעות חדשות`
      : escapeHtml(fallbackHeadline || `${label || 'Yad2 Hunter'} — אין מודעות חדשות`);
  const cards = (newAds || []).map(adRowHtml).join('');
  const footer = dashboardUrl
    ? `<p style="font-size:13px;color:#6b7280;margin-top:24px;">לוח בקרה: <a href="${escapeHtml(
        dashboardUrl
      )}" style="color:#1f49e0;">${escapeHtml(dashboardUrl)}</a></p>`
    : '';
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:640px;margin:0 auto;">
      <h1 style="font-size:20px;margin:0 0 16px;color:#111827;">${headline}</h1>
      ${cards}
      ${footer}
    </div>
  </body>
</html>`;
}

function buildPlainText({ newAds, label, runStartedAt, dashboardPath, fallbackHeadline }) {
  const dashboardUrl = buildDashboardUrl({ runStartedAt, dashboardPath });
  const lines = [];
  if (newAds && newAds.length) {
    lines.push(`${label || 'Yad2 Hunter'} — ${newAds.length} מודעות חדשות`);
    lines.push('');
    for (const ad of newAds) {
      const facts = [
        formatRooms(ad.rooms),
        formatPrice(ad.price, ad.hasExplicitPrice),
        formatPublished(ad)
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(`• ${truncate(ad.title || 'מודעה')}${ad.city ? ` · ${ad.city}` : ''}`);
      if (facts) lines.push(`  ${facts}`);
      if (ad.link) lines.push(`  ${ad.link}`);
      lines.push('');
    }
  } else {
    lines.push(fallbackHeadline || `${label || 'Yad2 Hunter'} — אין מודעות חדשות`);
    lines.push('');
  }
  if (dashboardUrl) {
    lines.push(`לוח בקרה: ${dashboardUrl}`);
  }
  return lines.join('\n');
}

function parseRecipients(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function missingCreds() {
  if (!env.EMAIL_NOTIFICATIONS_ENABLED) return 'Email notifications are disabled';
  if (!env.SMTP_HOST) return 'Missing SMTP_HOST';
  if (!env.SMTP_USER) return 'Missing SMTP_USER';
  if (!env.SMTP_PASS) return 'Missing SMTP_PASS';
  if (!env.SMTP_FROM) return 'Missing SMTP_FROM';
  if (!parseRecipients(env.EMAIL_RECIPIENTS).length) return 'Missing EMAIL_RECIPIENTS';
  return null;
}

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS
    }
  });
  return cachedTransporter;
}

async function sendEmail({ subject, html, text }) {
  const skipReason = missingCreds();
  if (skipReason) {
    return { skipped: true, reason: skipReason };
  }
  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from: env.SMTP_FROM,
    to: parseRecipients(env.EMAIL_RECIPIENTS),
    subject,
    html,
    text
  });
  return { skipped: false, messageId: info.messageId, accepted: info.accepted };
}

async function sendNewAdsDigestEmail({
  newAds,
  runStartedAt,
  label = 'לב הפארק',
  dashboardPath = '/lev-hapark'
} = {}) {
  if (!Array.isArray(newAds) || !newAds.length) {
    return { skipped: true, reason: 'No new ads' };
  }
  const subject = buildSubject({ newAds, label });
  const html = buildHtml({ newAds, label, runStartedAt, dashboardPath });
  const text = buildPlainText({ newAds, label, runStartedAt, dashboardPath });
  return sendEmail({ subject, html, text });
}

async function sendManualScanNoNewAdsEmail({
  runStartedAt,
  label = 'לב הפארק',
  dashboardPath = '/lev-hapark'
} = {}) {
  const fallbackHeadline = `${label} — סריקה ידנית הסתיימה, אין מודעות חדשות`;
  const subject = buildSubject({ newAds: [], label, suffix: 'סריקה ידנית — אין חדש' });
  const html = buildHtml({
    newAds: [],
    label,
    runStartedAt,
    dashboardPath,
    fallbackHeadline
  });
  const text = buildPlainText({
    newAds: [],
    label,
    runStartedAt,
    dashboardPath,
    fallbackHeadline
  });
  return sendEmail({ subject, html, text });
}

module.exports = {
  sendNewAdsDigestEmail,
  sendManualScanNoNewAdsEmail,
  // Exposed for tests.
  __testing: {
    buildSubject,
    buildHtml,
    buildPlainText,
    buildDashboardUrl,
    parseRecipients,
    missingCreds
  }
};
