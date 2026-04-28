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
  STATE_DIR: process.env.STATE_DIR || path.resolve(process.cwd(), 'state'),
  HISTORY_LIMIT: parseInteger(process.env.HISTORY_LIMIT, 50),
  SEEN_RETENTION_DAYS: parseInteger(process.env.SEEN_RETENTION_DAYS, 30),
  DASHBOARD_URL: (process.env.DASHBOARD_URL || '').trim()
};

module.exports = {
  env,
  parseBoolean,
  parseInteger
};
