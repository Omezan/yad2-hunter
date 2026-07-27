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
  TELEGRAM_PROXY_SECRET: process.env.TELEGRAM_PROXY_SECRET || '',
  PROXY_SERVER: process.env.PROXY_SERVER || '',
  PROXY_USERNAME: process.env.PROXY_USERNAME || '',
  PROXY_PASSWORD: process.env.PROXY_PASSWORD || '',
  // Bright Data Browser API WebSocket endpoint, e.g.
  // wss://brd-customer-...-zone-scraping_browser1:PASS@brd.superproxy.io:9222
  // When set, Playwright connects over CDP to Bright Data's managed
  // browser (auto unblocking) instead of launching local Chromium.
  BRIGHT_DATA_BROWSER_WS: (process.env.BRIGHT_DATA_BROWSER_WS || '').trim(),
  // How many searches to scrape in parallel. Only used on the Browser
  // API path (local Chromium stays sequential). Higher = faster but more
  // Bright Data session contention (slower per-session, more timeouts).
  // 0/unset lets the scraper pick a sensible default (3).
  SCRAPE_CONCURRENCY: parseInteger(process.env.SCRAPE_CONCURRENCY, 0),
  // How many extra fresh-session retry rounds to attempt for searches
  // that came back empty/partial (e.g. Radware blocked that exit IP).
  // Each round gets new Bright Data exit IPs. Only used on Browser API.
  SCRAPE_MAX_RETRY_ROUNDS: parseInteger(process.env.SCRAPE_MAX_RETRY_ROUNDS, 4),
  // Overall wall-clock budget (ms) for the scrape phase. Checked before
  // starting each search AND before each pagination step, so the run
  // always finishes gracefully (dedupe + notify) instead of being
  // hard-cancelled by the workflow timeout (which sends nothing). Keep
  // comfortably BELOW the workflow's timeout-minutes. Default 50 min.
  SCRAPE_TIME_BUDGET_MS: parseInteger(process.env.SCRAPE_TIME_BUDGET_MS, 50 * 60 * 1000),
  // Yad2's reported "X תוצאות" count often drifts a little from the number
  // of actually-paginable district listings (promoted/suggestion ads
  // inflate the headline count). Treat a search as complete when it lands
  // within this many of the reported count, so a 152/153 count-quirk does
  // NOT trigger a full multi-page re-scrape every retry round. Set 0 for
  // strict exact-match behavior. Default 2.
  SCRAPE_PARTIAL_TOLERANCE: parseInteger(process.env.SCRAPE_PARTIAL_TOLERANCE, 2)
};

module.exports = {
  env,
  parseBoolean,
  parseInteger
};
