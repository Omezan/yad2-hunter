const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env')
});

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseInteger(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  TELEGRAM_NOTIFICATIONS_ENABLED: parseBoolean(
    process.env.TELEGRAM_NOTIFICATIONS_ENABLED,
    true
  ),
  PLAYWRIGHT_HEADLESS: parseBoolean(process.env.PLAYWRIGHT_HEADLESS, true),
  SEARCH_TIMEOUT_MS: parseInteger(process.env.SEARCH_TIMEOUT_MS, 60000),
  ENABLED_SEARCH_IDS: process.env.ENABLED_SEARCH_IDS || '',
  // Comma-separated list of search ids whose ads should NEVER trigger
  // a "new ad" Telegram digest. They keep being scraped, written into
  // seen-ads, shown in the dashboard, and counted by the health-check;
  // we just stop pinging the user about them. The default is the
  // northern district as per the user's request.
  TELEGRAM_SUPPRESS_DISTRICT_IDS:
    process.env.TELEGRAM_SUPPRESS_DISTRICT_IDS || 'north-valleys',
  // Email transport for the Lev HaPark watch (and any future search
  // tagged with `notifyVia: 'email'`). All five SMTP_* variables are
  // required for an actual send — when any of them is missing the
  // email service skips gracefully (mirrors the Telegram service).
  EMAIL_NOTIFICATIONS_ENABLED: parseBoolean(
    process.env.EMAIL_NOTIFICATIONS_ENABLED,
    true
  ),
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInteger(process.env.SMTP_PORT, 465),
  SMTP_SECURE: parseBoolean(process.env.SMTP_SECURE, true),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || '',
  EMAIL_RECIPIENTS: process.env.EMAIL_RECIPIENTS || 'ohadmezan@gmail.com',
  STATE_DIR: process.env.STATE_DIR || path.resolve(process.cwd(), 'state'),
  HISTORY_LIMIT: parseInteger(process.env.HISTORY_LIMIT, 50),
  SEEN_RETENTION_DAYS: parseInteger(process.env.SEEN_RETENTION_DAYS, 30),
  DASHBOARD_URL: (process.env.DASHBOARD_URL || '').trim(),
  // Per-search cooldown: when Yad2 captcha-blocks a specific search
  // on the scheduled track, that *one* search is held out for this
  // many milliseconds (default 1h). The other searches keep
  // scanning normally. Set to 0 to disable the cooldown layer.
  SCRAPE_COOLDOWN_MS: parseInteger(process.env.SCRAPE_COOLDOWN_MS, 60 * 60 * 1000),
  TELEGRAM_PROXY_URL: process.env.TELEGRAM_PROXY_URL || '',
  TELEGRAM_PROXY_SECRET: process.env.TELEGRAM_PROXY_SECRET || ''
};

module.exports = {
  env,
  parseBoolean,
  parseInteger
};
