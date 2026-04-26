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

function normalizeBaseUrl(value, port) {
  if (!value) {
    return `http://localhost:${port}`;
  }

  return value.endsWith('/') ? value.slice(0, -1) : value;
}

const port = parseInteger(process.env.PORT, 3000);

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: port,
  DATABASE_URL: process.env.DATABASE_URL || '',
  APP_BASE_URL: normalizeBaseUrl(process.env.APP_BASE_URL, port),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  TELEGRAM_NOTIFICATIONS_ENABLED: parseBoolean(
    process.env.TELEGRAM_NOTIFICATIONS_ENABLED,
    true
  ),
  PLAYWRIGHT_HEADLESS: parseBoolean(process.env.PLAYWRIGHT_HEADLESS, true),
  SEARCH_TIMEOUT_MS: parseInteger(process.env.SEARCH_TIMEOUT_MS, 60000),
  SCAN_SCHEDULE: process.env.SCAN_SCHEDULE || '*/5 * * * *',
  ENABLE_LOCAL_CRON: parseBoolean(process.env.ENABLE_LOCAL_CRON, false),
  ENABLED_SEARCH_IDS: process.env.ENABLED_SEARCH_IDS || ''
};

module.exports = {
  env,
  parseBoolean,
  parseInteger
};
